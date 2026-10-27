"""Structured mind-map generation helpers."""
import json
import re


def build_mind_map_prompt() -> str:
    return (
        "Create a useful, natural mind map of the WHOLE lecture transcript. Return ONLY valid JSON with no markdown fences, "
        "using this schema: {\"title\": string, \"children\": [{\"label\": string, \"children\": [{\"label\": string, \"children\": []}]}]}. "
        "Use a short central title that names the lecture's main idea, not a generic title. "
        "Create 4-6 distinct main branches, arranged by conceptual relationship (for example: foundations, process/mechanism, components, examples/applications, trade-offs/limitations, outcomes), choosing only categories that fit this lecture. "
        "Under each branch, add 2-4 concise sub-branches that capture specific ideas, steps, definitions, examples, or consequences actually present in the transcript. Add a third level only when it clarifies a real relationship. "
        "Aim for about 25-35 total nodes so the complete map remains readable when printed on one landscape page. Prefer meaningful ideas over exhaustive tiny details. "
        "Represent meaningful parent-child relationships; do not simply copy the transcript order or produce a flat list. "
        "Use at most three levels below the root. Keep labels specific and short enough to scan. Avoid duplicate ideas and generic filler. "
        "Cover the lecture from beginning to end. Do not invent transcript-specific facts. Every node must contain a non-empty label and a children array."
    )


def parse_mind_map(raw: str) -> dict:
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE)
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        text = text[start:end + 1]
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {"title": "Lecture mind map", "children": [{"label": line.strip(" -*\t"), "children": []} for line in raw.splitlines() if line.strip()][:30]}
    if not isinstance(data, dict):
        return {"title": "Lecture mind map", "children": [{"label": line.strip(" -*\t"), "children": []} for line in raw.splitlines() if line.strip()][:30]}

    def clean(node, depth=0):
        if not isinstance(node, dict):
            return None
        label = str(node.get("label", "")).strip()[:180]
        if not label:
            return None
        children = []
        if depth < 3 and isinstance(node.get("children"), list):
            for child in node["children"][:10]:
                cleaned = clean(child, depth + 1)
                if cleaned:
                    children.append(cleaned)
        return {"label": label, "children": children}

    title = str(data.get("title") or "Lecture mind map").strip()[:180]
    children = []
    for item in data.get("children", [])[:8] if isinstance(data.get("children"), list) else []:
        cleaned = clean(item, 1)
        if cleaned:
            children.append(cleaned)
    return {"title": title or "Lecture mind map", "children": children}


def mind_map_to_text(data: dict, depth: int = 0) -> str:
    lines = [f"{'  ' * depth}- {data.get('title', data.get('label', ''))}"]
    for child in data.get("children", []):
        lines.append(mind_map_to_text(child, depth + 1))
    return "\n".join(lines)
