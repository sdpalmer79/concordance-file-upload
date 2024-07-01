# Perform checks
if [ -z "$MONGO_USERNAME" ]; then
  echo "MONGO_USERNAME is not set"
  exit 1
fi
if [ -z "$MONGO_PASSWORD" ]; then
  echo "MONGO_PASSWORD is not set"
  exit 1
fi
if [ -z "$MONGO_SERVER" ]; then
  echo "MONGO_SERVER is not set"
  exit 1
fi
if [ -z "$MONGO_APP_NAME" ]; then
  echo "MONGO_APP_NAME is not set"
  exit 1
fi
if [ "$AI_API" = "OPEN_AI" ] || [ "$AI_API" = "ANTHROPIC" ]; then
  echo "AI_API is set to $AI_API"
else
  echo "AI_API must be set to either OPEN_AI or ANTHROPIC"
  exit 1
fi

# Execute the application
exec node server.js