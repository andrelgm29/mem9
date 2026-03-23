# Use pre-built mem9 image from Docker Hub
FROM qiffang/mnemos:latest

EXPOSE 8080

CMD ["./mnemo-server"]
