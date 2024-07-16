# Conversation Management

ICE offers robust conversation management features to help you organize and maintain your LLM interactions.

## .chat Files

- Conversations are saved as `.chat` files in YAML format.
- These files can be version-controlled, shared, and edited like any text file.

## Structure

Each `.chat` file contains:
- Metadata (provider, model, etc.)
- Message history (user and AI responses)
- Message editing history
- Configuration changes

## Advantages

- Easy to review and edit past conversations
- Integration with version control systems
- Portable format for sharing or archiving chats
- Local-first approach to LLM history storage

## Best Practices

- Use meaningful file names for your `.chat` files
- Organize `.chat` files in project-relevant directories
- For casual chats, consider using [Instant Chat](instant-chat.md) for quick queries. Instant Chat automatically creates `.chat` files with a timestamped name.