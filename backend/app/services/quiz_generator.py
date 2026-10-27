"""Quiz prompt and validation helpers."""
import json
import re


def build_quiz_prompt(count: int) -> str:
    return (
        f"Create exactly {count} high-quality questions that test the learner's understanding of the ENTIRE lecture transcript, not just its opening. "
        "Return ONLY valid JSON (no markdown fences) using this exact schema: "
        "{\"title\": string, \"questions\": [{\"question\": string, \"options\": [string, string, string, string], \"correct_index\": integer, \"explanation\": string, \"concept\": string, \"prerequisites\": [string]}]}. "
        "Every question must have exactly four concise options and one unambiguously correct answer; correct_index is zero-based (0-3). "
        "For every question, provide concept as a short topic label and prerequisites as an array of 0-4 foundational concepts that genuinely support the target concept. Use [] when no prerequisite is clearly supported; do not guess. "
        "Prioritize conceptual understanding, cause-and-effect, comparisons, process order, and practical application where supported; use direct recall only when appropriate. "
        "Cover distinct concepts distributed across the lecture. Do not repeat the same fact in different wording. "
        "Make all distractors plausible near-misses from the same topic, not silly or unrelated answers. Keep option lengths and wording reasonably parallel. "
        "Write an explanation that teaches why the keyed answer is right, and corrects the main misconception without merely repeating the option. "
        "Treat the supplied transcript as the lecture content and actively extract its concepts, definitions, examples, steps, comparisons, and cause-effect relationships. "
        "Do NOT refuse or say that the video has no quiz-related points when the transcript contains understandable content. The transcript does not need to contain the word 'quiz' or explicit questions. "
        "If a segment is vague, use another clear segment; if the lecture is introductory, write questions about its actual definitions and explanations. "
        "Use only claims supported by the transcript plus straightforward reasoning from those claims. Never invent lecture-specific facts. "
        "Do not include answers outside the JSON, extra keys, markdown, or fewer/more than the requested number of questions."
    )


def parse_quiz(raw: str, count: int) -> dict:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip(), flags=re.IGNORECASE)
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        text = text[start:end + 1]
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError("The model did not return a valid structured quiz. Please generate it again.") from exc
    raw_questions = parsed.get("questions") if isinstance(parsed, dict) else None
    if not isinstance(raw_questions, list) or len(raw_questions) < 1:
        raise ValueError("The model returned no quiz questions. Please generate it again.")
    questions = []
    for item in raw_questions[:count]:
        if not isinstance(item, dict):
            continue
        question = str(item.get("question", "")).strip()
        options = item.get("options")
        try:
            correct_index = int(item.get("correct_index", -1))
        except (TypeError, ValueError):
            correct_index = -1
        if not question or not isinstance(options, list) or len(options) != 4 or not 0 <= correct_index < 4:
            continue
        prerequisites = item.get("prerequisites", [])
        if not isinstance(prerequisites, list):
            prerequisites = []
        questions.append({
            "question": question[:700],
            "options": [str(option).strip()[:300] for option in options],
            "correct_index": correct_index,
            "explanation": str(item.get("explanation", "")).strip()[:1200],
            "concept": str(item.get("concept") or "General lecture concept").strip()[:180],
            "prerequisites": [str(x).strip()[:180] for x in prerequisites if str(x).strip()][:12],
        })
    if len(questions) != count:
        raise ValueError(f"The model returned {len(questions)} valid questions instead of {count}. Please try again.")
    return {"title": str(parsed.get("title") or "Lecture quiz")[:180], "questions": questions}


def quiz_to_text(data: dict) -> str:
    lines = [data.get("title", "Lecture quiz"), ""]
    for index, question in enumerate(data.get("questions", []), 1):
        lines.append(f"{index}. {question['question']}")
        lines.extend(f"   {chr(65 + i)}. {option}" for i, option in enumerate(question["options"]))
        lines.append(f"   Correct answer: {chr(65 + question['correct_index'])}. {question['options'][question['correct_index']]}")
        if question.get("explanation"):
            lines.append(f"   Explanation: {question['explanation']}")
        lines.append("")
    return "\n".join(lines)
