"""Prompt builders for lecture note generation modes."""


def build_notes_prompt(mode: str) -> str:
    if mode == "crisp":
        return (
            "Create SHORT, CRISP, high-yield revision notes using only this lecture transcript. "
            "Prioritize important definitions, core ideas, formulas, steps, distinctions, and likely exam points. "
            "Use compact bullets, bold-style labels where helpful, and avoid long explanations, repetition, generic advice, "
            "and facts not supported by the lecture. Aim for a fast 1-3 minute revision sheet. "
            "If the transcript does not mention formulas or examples, do not invent them. Include a tiny final 'Remember' list."
        )
    return (
        "Create FULL, STRUCTURED study notes from this lecture transcript. Use a descriptive title, short overview, "
        "logical headings and subheadings, explain each important concept in clear language, preserve meaningful steps, "
        "definitions, formulas, examples, comparisons, and cause-effect relationships found in the lecture, then end with "
        "a summary and key takeaways. Keep the notes organized and readable, not one giant paragraph. "
        "Do not invent lecture-specific facts; label any helpful explanation beyond the transcript as 'Additional explanation'. "
        "Use timestamps sparingly and only when useful."
    )
