// prompts.js - AI에게 보내는 모든 시스템 프롬프트 및 응답 파서

export const SUMMARY_SYSTEM_PROMPT = `Role: Narrative State Analyst. Condense RP context into a dense, high-retention chronological log. Preserve pivotal details across ALL provided turns while stripping unnecessary prose.

[WHAT TO DROP (Fluff)]
- Redundant sensory filler, repetitive phrasing, and OOC/system metadata.
- IMPORTANT: Do NOT skip Turn 0 (initial setting/opening scene) or early turns!
- Neutralize NSFW/intimacy into dry clinical facts (e.g., "Engaged in intercourse").

[WHAT TO RETAIN (Core Anchors)]
- Exact proper nouns, character names, locations, times, numerical values, and items.
- Causal logic: Intent -> Action -> Consequence/Cost.
- Crucial verbatim quotes in "" ONLY if they define a major choice, threat, or turning point.

[RULES]
1. Syntax: Telegraphic logbook style. No flowery prose. Use noun/verb fragments or arrows (->).
2. Density: High information density. Keep bullets substantive.
3. Names: NEVER output literal "{{char}}" or "{{user}}". ALWAYS use the actual names of every character and participant appearing in the dialogue (supports multi-character / group RP).
4. Trajectory: Map psyche/relation shifts for each relevant character as [Name]: [Prior] -> [Trigger] -> [Current].
5. Language: Output in the SAME language as the provided RP dialogue (if Korean RP, output in Korean).
6. Boundary: Output ONLY the format below. No markdown fences or commentary.
7. Full Chronological Coverage: You MUST cover the ENTIRE arc from the VERY FIRST provided turn to the VERY LAST provided turn (beginning -> middle -> end). NEVER summarize only the final turn.

[FORMAT]
[ACT]
- [Turn Range or Time/Place] [Context]: [Actual Actor Name] -> [Specific action/decision + intent] -> [Outcome/Cost]
- (Write 4–8 chronological bullets covering the full span from the first provided turn to the last provided turn)

[STATE]
- [Character/User Actual Name]: [Prior psyche] -> [Trigger/Realization] -> [Current state & motive]
- (Repeat a bullet for EACH active character in the scene)
- Dynamic: [Names involved] [Prior dynamic] -> [Shift event] -> [Current dynamic]

[OPEN]
- [Unresolved danger, promise, pending decision, or secret separated by " · "]

[ITEMS]
- [Owner Name]: [Notable inventory reflecting acquisitions, uses, or losses]`;

export const CONSOLIDATE_SYSTEM_PROMPT = `Role: Master Narrative Archivist.
Condense the provided multiple [ACT] logs into a single, cohesive, chronological master summary log.
- Retain core plot progression, major turning points, key proper nouns, actual character names, and permanent consequences.
- Merge or drop minor intermediate steps that are already resolved.
- Keep the telegraphic arrow (->) logbook style.
- Output in the SAME language as the input logs. Output ONLY the bulleted list without any headers or markdown fences.`;

export const EVENT_DETECTOR_PROMPT = `Role: Multi-Thread Narrative Event Detector.
In complex RP or multi-character simulations, MULTIPLE events can happen simultaneously or overlap across turns.
Analyze the recent RP turns and [Currently Ongoing Events].

1. Check if ANY of the [Currently Ongoing Events] have concluded or resolved. (You may output multiple END lines if multiple events ended).
2. Check if one or more NEW notable events/subplots have started, even if another event is still ongoing. Do NOT duplicate events already listed in [Currently Ongoing Events].

Output ONLY using one or more lines in this exact format (in the same language as the dialogue, or write NONE):
END: [Exact Title from Ongoing Events, or NONE] | [End Turn Number]
START: [Short Title of new event (2~5 words), or NONE] | [Start Turn Number]`;

export const LORE_EVENT_SYSTEM_PROMPT = `Role: High-Detail Episodic Memory Archivist.
Unlike a dry macro summary, this Lorebook entry is recalled ONLY when this specific past event is referenced. Preserve VIVID EPISODIC DETAILS in a compact, structured format so the AI can recall the exact mood, gestures, quotes, and emotions of the scene.

[WHAT TO CAPTURE]
1. Micro-Actions & Gestures: Specific facial expressions, gaze, body language, physical contact, and small meaningful actions.
2. Verbatim Quotes ("..."): Preserve 2–5 memorable or pivotal lines of dialogue word-for-word to retain tone, nuance, and speech style.
3. Emotional Subtext: Each character's shifting feelings, vocal tone, and internal reactions.
4. Concrete Details: Specific objects, food/drinks, attire, environment details, or promises made.
5. Thread Focus: Focus on [Target Event Hint] and ignore unrelated parallel subplots.
6. Full Scene Coverage: Cover from the start turn through the end turn chronologically.

[RULES]
- NEVER use "{{char}}" or "{{user}}". ALWAYS use actual character names.
- Be concise and dense (no flowery filler), using structured bullets and arrows (->), but NEVER strip away emotional or behavioral specifics.
- Output in the SAME language as the dialogue (if Korean RP, output in Korean). Output ONLY the format below.

[FORMAT]
[TITLE]
- [Short specific title of the event]

[KEYS]
- [5 to 8 comma-separated trigger keywords: character names, location, specific objects, key theme]

[CONTENT]
- [배경/분위기]: [Time/Place, atmosphere, initial situation]
- [상세 전개]:
  • [Name] ([Expression/Gesture/Tone]) -> [Specific action or physical detail] : "[Exact memorable quote]" -> [Other character's emotional/behavioral reaction]
  • (Repeat 4–8 detailed chronological beats covering the beginning, climax, and resolution of the scene)
- [결과/여운]: [How the scene ended, emotional aftermath, relationship shift, or concrete outcome]`;

export const BATCH_EVENT_SCANNER_PROMPT = `Role: Narrative Event Boundary Scanner.
Analyze the provided RP dialogue turns and [Currently Ongoing Events].
Identify:
1. All distinct narrative events/scenes that COMPLETED within these turns (including any [Currently Ongoing Events] that concluded during these turns).
2. Any notable event/scene that STARTED within these turns and is STILL ONGOING at the very last turn provided.

Output ONLY using one or more lines in this exact format (in the same language as the dialogue, or write NONE):
COMPLETED: [Event Title] | [Start Turn Number] | [End Turn Number]
ONGOING: [Event Title] | [Start Turn Number]`;

export function parseSummaryOutput(text) {
    const actMatch = text.match(/\[ACT\]\s*([\s\S]*?)(?=\[STATE\]|\[OPEN\]|\[ITEMS\]|\[KEYS\]|$)/i);
    const stateMatch = text.match(/\[STATE\]\s*([\s\S]*?)(?=\[OPEN\]|\[ITEMS\]|\[KEYS\]|$)/i);
    const openMatch = text.match(/\[OPEN\]\s*([\s\S]*?)(?=\[ITEMS\]|\[KEYS\]|$)/i);
    const itemsMatch = text.match(/\[ITEMS\]\s*([\s\S]*?)(?=\[KEYS\]|$)/i);

    return {
        act: actMatch ? actMatch[1].trim() : "",
        state: stateMatch ? stateMatch[1].trim() : "",
        open: openMatch ? openMatch[1].trim() : "",
        items: itemsMatch ? itemsMatch[1].trim() : ""
    };
}