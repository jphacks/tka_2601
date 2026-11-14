"""Bounded vocabulary hints for independent Japanese Whisper utterances."""


def decoding_options(tokenizer, prompt, device="cuda:0", beams=3):
    options = {"language": "ja", "task": "transcribe", "do_sample": False,
               "num_beams": max(1, min(5, int(beams))), "max_new_tokens": 256}
    # Whisper reserves half its 448-token context for the prompt. No transcript
    # history is passed here; each request supplies only its vocabulary hint.
    hint = prompt.strip()[:200]
    if hint:
        ids = tokenizer.get_prompt_ids(hint, return_tensors="pt")
        while len(ids) > 223 and hint:
            hint = hint[:max(0, len(hint) - 16)]
            ids = tokenizer.get_prompt_ids(hint, return_tensors="pt") if hint else None
        if hint:
            options["prompt_ids"] = ids.to(device)
    return options
