from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:11434/v1",
    api_key="ollama",  # this value is ignored but required
)

response = client.chat.completions.create(
    model="mistral",
    messages=[
        {"role": "user", "content": "Summarize what quantum entanglement is."}
    ]
)

print("\nSUMMARY:\n", response.choices[0].message.content)