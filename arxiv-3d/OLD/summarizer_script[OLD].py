from llama_cpp import Llama

# Load local model
llm = Llama(model_path="models/mistral-7b-instruct-v0.1.Q4_K_M.gguf", n_ctx=2048)

# Your paper abstract
abstract = "Quantum entanglement is a physical phenomenon..."

# Prompt template
prompt = f"[INST] Summarize the following scientific abstract:\n{abstract}\n[/INST]"

# Get summary
output = llm(prompt, max_tokens=300, stop=["</s>"])
print("Summary:\n", output["choices"][0]["text"].strip())