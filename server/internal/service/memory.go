package service

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sort"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/qiffang/mnemos/server/internal/domain"
	"github.com/qiffang/mnemos/server/internal/embed"
	"github.com/qiffang/mnemos/server/internal/repository"
)

const (
	maxContentLen = 50000
	maxTags       = 20
	maxKeyLen     = 255
	maxBulkSize   = 100
)

type MemoryService struct {
	memories     repository.MemoryRepo
	embedder     *embed.Embedder
	autoModel    string
	ftsAvailable bool
}

func NewMemoryService(memories repository.MemoryRepo, embedder *embed.Embedder, autoModel string, ftsAvailable bool) *MemoryService {
	return &MemoryService{memories: memories, embedder: embedder, autoModel: autoModel, ftsAvailable: ftsAvailable}
}

func (s *MemoryService) Create(ctx context.Context, spaceID, agentName, content, keyName string, tags []string, metadata json.RawMessage, clock map[string]uint64, writeID string) (*domain.WriteResult, error) {
	if err := validateMemoryInput(content, keyName, tags); err != nil {
		return nil, err
	}

	var embedding []float32
	if s.autoModel == "" && s.embedder != nil {
		var err error
		embedding, err = s.embedder.Embed(ctx, content)
		if err != nil {
			return nil, err
		}
	}

	now := time.Now()
	m := &domain.Memory{
		ID:          uuid.New().String(),
		SpaceID:     spaceID,
		Content:     content,
		KeyName:     keyName,
		Source:      agentName,
		Tags:        tags,
		Metadata:    metadata,
		Embedding:   embedding,
		Version:     1,
		UpdatedBy:   agentName,
		OriginAgent: agentName,
		CreatedAt:   now,
		UpdatedAt:   now,
		WriteID:     writeID,
	}

	if clock != nil {
		return s.createWithClock(ctx, spaceID, agentName, keyName, m, clock)
	}

	return s.createLWW(ctx, spaceID, keyName, m)
}

func (s *MemoryService) createLWW(ctx context.Context, spaceID, keyName string, m *domain.Memory) (*domain.WriteResult, error) {
	if keyName != "" {
		if err := s.memories.Upsert(ctx, m); err != nil {
			return nil, err
		}
		existing, err := s.memories.GetByKey(ctx, spaceID, keyName)
		if err != nil {
			return &domain.WriteResult{Memory: m}, nil
		}
		return &domain.WriteResult{Memory: existing}, nil
	}

	if err := s.memories.Create(ctx, m); err != nil {
		return nil, err
	}
	return &domain.WriteResult{Memory: m}, nil
}

func (s *MemoryService) createWithClock(ctx context.Context, spaceID, agentName, keyName string, incoming *domain.Memory, clock map[string]uint64) (*domain.WriteResult, error) {
	if keyName == "" {
		incoming.VectorClock = clock
		if err := s.memories.Create(ctx, incoming); err != nil {
			return nil, err
		}
		return &domain.WriteResult{Memory: incoming, Winner: agentName}, nil
	}

	isSectionMerge := false

	decide := func(existing *domain.Memory) (*domain.Memory, bool, error) {
		if existing == nil {
			incoming.VectorClock = clock
			return incoming, false, nil
		}

		existingClock := existing.VectorClock
		if existingClock == nil {
			existingClock = make(map[string]uint64)
		}

		rel := CompareClocks(clock, existingClock)
		merged := MergeVectorClocks(clock, existingClock)

		switch rel {
		case ClockDominates:
			incoming.VectorClock = merged
			return incoming, false, nil

		case ClockDominated, ClockEqual:
			return nil, true, nil

		case ClockConcurrent:
			mergedMeta, mergedContent, canMerge := MergeSectionMetadata(
				existing.Metadata, incoming.Metadata, incoming.OriginAgent,
			)
			if canMerge {
				incoming.Metadata = mergedMeta
				incoming.Content = mergedContent
				incoming.VectorClock = merged
				isSectionMerge = true
				return incoming, false, nil
			}

			incomingCandidate := &WriteCandidate{ID: incoming.ID, OriginAgent: incoming.OriginAgent}
			existingCandidate := &WriteCandidate{ID: existing.ID, OriginAgent: existing.OriginAgent}
			winner := TieBreak(incomingCandidate, existingCandidate)

			if winner.ID == incoming.ID {
				incoming.VectorClock = merged
				return incoming, false, nil
			}
			return nil, true, nil

		default:
			return nil, true, nil
		}
	}

	mem, dominated, err := s.memories.CRDTUpsert(ctx, spaceID, keyName, incoming, decide)
	if err != nil {
		return nil, err
	}

	winner := agentName
	if dominated && mem != nil {
		winner = mem.OriginAgent
	}

	return &domain.WriteResult{
		Memory:    mem,
		Dominated: dominated,
		Winner:    winner,
		Merged:    isSectionMerge,
	}, nil
}

// Get returns a single memory by ID.
func (s *MemoryService) Get(ctx context.Context, spaceID, id string) (*domain.Memory, error) {
	return s.memories.GetByID(ctx, spaceID, id)
}

func (s *MemoryService) Search(ctx context.Context, spaceID string, filter domain.MemoryFilter) ([]domain.Memory, int, error) {
	if filter.Query == "" {
		return s.memories.List(ctx, spaceID, filter)
	}
	if s.autoModel != "" {
		return s.autoHybridSearch(ctx, spaceID, filter)
	}
	if s.embedder != nil {
		return s.hybridSearch(ctx, spaceID, filter)
	}
	if s.ftsAvailable {
		return s.ftsOnlySearch(ctx, spaceID, filter)
	}
	return s.memories.List(ctx, spaceID, filter)
}

const rrfK = 60.0

func rrfMerge(ftsResults, vecResults []domain.Memory) map[string]float64 {
	scores := make(map[string]float64, len(ftsResults)+len(vecResults))
	for rank, m := range ftsResults {
		scores[m.ID] += 1.0 / (rrfK + float64(rank+1))
	}
	for rank, m := range vecResults {
		scores[m.ID] += 1.0 / (rrfK + float64(rank+1))
	}
	return scores
}

func (s *MemoryService) paginate(results []domain.Memory, offset, limit int) ([]domain.Memory, int) {
	total := len(results)
	if offset >= total {
		return []domain.Memory{}, total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	return results[offset:end], total
}

func (s *MemoryService) ftsOnlySearch(ctx context.Context, spaceID string, filter domain.MemoryFilter) ([]domain.Memory, int, error) {
	limit := filter.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	offset := filter.Offset
	if offset < 0 {
		offset = 0
	}
	fetchLimit := limit * 3

	ftsResults, err := s.memories.FTSSearch(ctx, spaceID, filter.Query, filter, fetchLimit)
	if err != nil {
		slog.Warn("FTS search failed, falling back to list", "err", err)
		return s.memories.List(ctx, spaceID, filter)
	}

	page, total := s.paginate(ftsResults, offset, limit)
	return page, total, nil
}

func (s *MemoryService) hybridSearch(ctx context.Context, spaceID string, filter domain.MemoryFilter) ([]domain.Memory, int, error) {
	limit := filter.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	offset := filter.Offset
	if offset < 0 {
		offset = 0
	}
	fetchLimit := limit * 3

	queryVec, err := s.embedder.Embed(ctx, filter.Query)
	if err != nil {
		slog.Warn("embedding failed, falling back to keyword search", "err", err)
		if s.ftsAvailable {
			return s.ftsOnlySearch(ctx, spaceID, filter)
		}
		return s.memories.List(ctx, spaceID, filter)
	}

	vecResults, vecErr := s.memories.VectorSearch(ctx, spaceID, queryVec, filter, fetchLimit)
	if vecErr != nil {
		slog.Warn("vector leg skipped", "err", vecErr)
		vecResults = nil
	}

	var kwResults []domain.Memory
	var kwErr error
	if s.ftsAvailable {
		kwResults, kwErr = s.memories.FTSSearch(ctx, spaceID, filter.Query, filter, fetchLimit)
		if kwErr != nil {
			slog.Warn("keyword leg skipped", "err", kwErr)
			kwResults = nil
		}
	} else {
		kwResults, kwErr = s.memories.KeywordSearch(ctx, spaceID, filter.Query, filter, fetchLimit)
		if kwErr != nil {
			slog.Warn("keyword leg skipped", "err", kwErr)
			kwResults = nil
		}
	}

	if vecErr != nil && kwErr != nil {
		slog.Error("both search legs failed")
		return []domain.Memory{}, 0, nil
	}

	scores := rrfMerge(kwResults, vecResults)
	mems := collectMems(kwResults, vecResults)
	merged := sortByScore(mems, scores)

	page, total := s.paginate(merged, offset, limit)
	return setScores(page, scores), total, nil
}

func (s *MemoryService) autoHybridSearch(ctx context.Context, spaceID string, filter domain.MemoryFilter) ([]domain.Memory, int, error) {
	limit := filter.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	offset := filter.Offset
	if offset < 0 {
		offset = 0
	}
	fetchLimit := limit * 3

	vecResults, vecErr := s.memories.AutoVectorSearch(ctx, spaceID, filter.Query, filter, fetchLimit)
	if vecErr != nil {
		slog.Warn("vector leg skipped", "err", vecErr)
		vecResults = nil
	}

	var kwResults []domain.Memory
	var kwErr error
	if s.ftsAvailable {
		kwResults, kwErr = s.memories.FTSSearch(ctx, spaceID, filter.Query, filter, fetchLimit)
		if kwErr != nil {
			slog.Warn("keyword leg skipped", "err", kwErr)
			kwResults = nil
		}
	} else {
		kwResults, kwErr = s.memories.KeywordSearch(ctx, spaceID, filter.Query, filter, fetchLimit)
		if kwErr != nil {
			slog.Warn("keyword leg skipped", "err", kwErr)
			kwResults = nil
		}
	}

	if vecErr != nil && kwErr != nil {
		slog.Error("both search legs failed")
		return []domain.Memory{}, 0, nil
	}

	scores := rrfMerge(kwResults, vecResults)
	mems := collectMems(kwResults, vecResults)
	merged := sortByScore(mems, scores)

	page, total := s.paginate(merged, offset, limit)
	return setScores(page, scores), total, nil
}

func collectMems(kwResults, vecResults []domain.Memory) map[string]domain.Memory {
	mems := make(map[string]domain.Memory, len(kwResults)+len(vecResults))
	for _, m := range kwResults {
		mems[m.ID] = m
	}
	for _, m := range vecResults {
		if _, seen := mems[m.ID]; !seen {
			mems[m.ID] = m
		}
	}
	return mems
}

func sortByScore(mems map[string]domain.Memory, scores map[string]float64) []domain.Memory {
	result := make([]domain.Memory, 0, len(mems))
	for id := range mems {
		result = append(result, mems[id])
	}
	sort.Slice(result, func(i, j int) bool {
		return scores[result[i].ID] > scores[result[j].ID]
	})
	return result
}

func setScores(page []domain.Memory, scores map[string]float64) []domain.Memory {
	for i := range page {
		sc := scores[page[i].ID]
		page[i].Score = &sc
	}
	return page
}

// Update modifies an existing memory with LWW conflict resolution.
func (s *MemoryService) Update(ctx context.Context, spaceID, agentName, id, content string, tags []string, metadata json.RawMessage, ifMatch int) (*domain.Memory, error) {
	current, err := s.memories.GetByID(ctx, spaceID, id)
	if err != nil {
		return nil, err
	}

	if ifMatch > 0 && ifMatch != current.Version {
		slog.Warn("version conflict, applying LWW",
			"memory_id", id,
			"expected_version", ifMatch,
			"actual_version", current.Version,
			"agent", agentName,
		)
	}

	contentChanged := false
	if content != "" {
		if len(content) > maxContentLen {
			return nil, &domain.ValidationError{Field: "content", Message: "too long (max 50000)"}
		}
		current.Content = content
		contentChanged = true
	}
	if tags != nil {
		if len(tags) > maxTags {
			return nil, &domain.ValidationError{Field: "tags", Message: "too many (max 20)"}
		}
		current.Tags = tags
	}
	if metadata != nil {
		current.Metadata = metadata
	}
	current.UpdatedBy = agentName

	if contentChanged && s.autoModel == "" && s.embedder != nil {
		embedding, err := s.embedder.Embed(ctx, current.Content)
		if err != nil {
			return nil, err
		}
		current.Embedding = embedding
	}

	if err := s.memories.UpdateOptimistic(ctx, current, 0); err != nil {
		return nil, err
	}

	updated, err := s.memories.GetByID(ctx, spaceID, id)
	if err != nil {
		current.Version++
		return current, nil
	}
	return updated, nil
}

func (s *MemoryService) Delete(ctx context.Context, spaceID, id, agentName string) error {
	return s.memories.SoftDelete(ctx, spaceID, id, agentName)
}

func (s *MemoryService) Bootstrap(ctx context.Context, spaceID string, limit int) ([]domain.Memory, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	return s.memories.ListBootstrap(ctx, spaceID, limit)
}

// BulkCreate creates multiple memories at once.
func (s *MemoryService) BulkCreate(ctx context.Context, spaceID, agentName string, items []BulkMemoryInput) ([]domain.Memory, error) {
	if len(items) == 0 {
		return nil, &domain.ValidationError{Field: "memories", Message: "required"}
	}
	if len(items) > maxBulkSize {
		return nil, &domain.ValidationError{Field: "memories", Message: "too many (max 100)"}
	}

	now := time.Now()
	memories := make([]*domain.Memory, 0, len(items))
	for i, item := range items {
		if err := validateMemoryInput(item.Content, item.Key, item.Tags); err != nil {
			var ve *domain.ValidationError
			if errors.As(err, &ve) {
				ve.Field = "memories[" + strconv.Itoa(i) + "]." + ve.Field
			}
			return nil, err
		}

		var embedding []float32
		if s.autoModel == "" && s.embedder != nil {
			var err error
			embedding, err = s.embedder.Embed(ctx, item.Content)
			if err != nil {
				return nil, err
			}
		}

		memories = append(memories, &domain.Memory{
			ID:        uuid.New().String(),
			SpaceID:   spaceID,
			Content:   item.Content,
			KeyName:   item.Key,
			Source:    agentName,
			Tags:      item.Tags,
			Metadata:  item.Metadata,
			Embedding: embedding,
			Version:   1,
			UpdatedBy: agentName,
			CreatedAt: now,
			UpdatedAt: now,
		})
	}

	if err := s.memories.BulkCreate(ctx, memories); err != nil {
		return nil, err
	}

	result := make([]domain.Memory, len(memories))
	for i, m := range memories {
		result[i] = *m
	}
	return result, nil
}

// BulkMemoryInput is the input shape for each item in a bulk create request.
type BulkMemoryInput struct {
	Content  string          `json:"content"`
	Key      string          `json:"key,omitempty"`
	Tags     []string        `json:"tags,omitempty"`
	Metadata json.RawMessage `json:"metadata,omitempty"`
}

func validateMemoryInput(content, key string, tags []string) error {
	if content == "" {
		return &domain.ValidationError{Field: "content", Message: "required"}
	}
	if len(content) > maxContentLen {
		return &domain.ValidationError{Field: "content", Message: "too long (max 50000)"}
	}
	if len(key) > maxKeyLen {
		return &domain.ValidationError{Field: "key", Message: "too long (max 255)"}
	}
	if len(tags) > maxTags {
		return &domain.ValidationError{Field: "tags", Message: "too many (max 20)"}
	}
	return nil
}
