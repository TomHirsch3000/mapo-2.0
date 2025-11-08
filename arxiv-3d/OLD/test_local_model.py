from llama_cpp import Llama

# Load the model (adjust path if needed)
llm = Llama(model_path="models/mistral-7b-instruct-v0.1.Q4_K_M.gguf", n_ctx=2048)

# Abstract to summarize
abstract = (
    "Quantum entanglement is a physical phenomenon that occurs when pairs or groups of particles "
    "are generated or interact in such a way that the quantum state of each particle cannot be described "
    "independently of the others. This paper explores recent developments in entanglement-based quantum communication systems."
)

# Instruct-style prompt
prompt = f"[INST] Summarize the following scientific abstract:\n{abstract}\n[/INST]"

# Run the model
output = llm(prompt, max_tokens=300, stop=["</s>"])

# Print result
print("\nSUMMARY:\n", output["choices"][0]["text"].strip())