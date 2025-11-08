import os
from dotenv import load_dotenv
from openai import OpenAI

# Load API key from .env
load_dotenv()
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# Make request to GPT-4o
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[
        {"role": "user", "content": "Summarize what quantum entanglement is."}
    ],
    temperature=0.5
)

print("\nSUMMARY:\n", response.choices[0].message.content)