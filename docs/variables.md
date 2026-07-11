# System Prompt Variables

ICE supports built-in **environment variables** in system prompts, enabling dynamic, context-aware interactions with LLMs. These are particularly useful for providing information that would otherwise have to be updated manually. Each variable is automatically replaced with its corresponding value when the system prompt is sent to the LLM.

## Available Environment Variables

| Variable | Description | Example Output |
|----------|-------------|----------------|
| {{ TIME_NOW }} | Current time in 24-hour format | 14:30:45 |
| {{ TIME_NOW_12H }} | Current time in 12-hour format | 09:41:23 PM |
| {{ DATE_TODAY }} | Today's date in ISO format | 2024-07-22 |
| {{ DATE_TODAY_SHORT }} | Today's date in short format | 07/22/24 |
| {{ DATE_TODAY_LONG }} | Today's date in long format | July 22, 2024 |

## Using Environment Variables

You can include these variables directly in your system prompts. They will be automatically replaced with their corresponding values when the system prompt is sent to the LLM.

Example usage in a system prompt:
```
You are an AI assistant. The current date is {{ DATE_TODAY_LONG }} and the time is {{ TIME_NOW_12H }}.
```

This might be expanded to:
```
You are an AI assistant. The current date is July 22, 2024 and the time is 09:41:23 PM.
```

