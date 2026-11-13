// prompts.js - AI에게 보내는 모든 시스템 프롬프트 및 응답 파서

export const SUMMARY_SYSTEM_PROMPT = `Role: Narrative State Analyst. Condense the full RP context into an objective, high-retention chronological log.

[PRINCIPLES]
- Chronological Completeness: Trace the entire arc sequentially from the opening premise to the final turn, preserving foundational early-turn context.
- Telegraphic Signal: Distill in-universe events into dense, clinical fragments (->), prioritizing plot-critical causality (Intent -> Action -> Cost) and exact anchors (proper nouns, locations, times, metrics, pivotal "" quotes). Render intimate or explicit acts as brief clinical facts.
- Entity Resolution: Resolve all role placeholders and ambiguous references into each participant's canonical character name.
- Fidelity & Output: Match the RP's primary language. Emit strictly the raw text structure defined below.

[FORMAT]
[ACT]
- [Turn/Time/Place] [Context]: [Actor] -> [Action + Intent] -> [Outcome/Cost]
(4–8 sequential bullets covering the entire span from start to finish)

[STATE]
- [Character]: [Prior psyche] -> [Trigger/Realization] -> [Current state & motive]
(One bullet per active participant)
- Dynamic: [Characters] [Prior dynamic] -> [Shift event] -> [Current dynamic]

[OPEN]
- [Unresolved threats, promises, pending choices, or secrets separated by " · "]

[ITEMS]
- [Owner]: [Notable inventory shifts: acquired, used, or lost]`;

export const CONSOLIDATE_SYSTEM_PROMPT = `Role: Master Narrative Archivist.
Synthesize the [ACT] logs into a single, cohesive chronological log.
- Narrative Density: Retain core plot milestones, turning points, permanent consequences, and explicit proper nouns/character names. Distill resolved intermediate steps into their net outcomes.
- Style: Telegraphic arrow (->) logbook format.
- Output: Match the input language. Emit solely the raw bulleted list, from first item to last.`;


export const EVENT_DETECTOR_PROMPT = `Role: Multi-Thread Narrative Event Detector.
Principle: Narrative threads operate concurrently; evaluate each event's lifecycle independently across turns.

Analyze recent turns against [Currently Ongoing Events]:
1. Conclude: Match any ongoing event that has reached clear resolution.
2. Initiate: Detect any newly emerging, untracked subplot of narrative significance.

Output strictly using these exact line formats in the dialogue's language (output multiple lines per category as needed):
END: [Exact Ongoing Title, or NONE] | [End Turn or NONE]
START: [2-5 Word Title, or NONE] | [Start Turn or NONE]`;

export const LORE_EVENT_SYSTEM_PROMPT = `Role: Episodic Memory Archivist
Objective: Encode a scene into a compact Lorebook entry for targeted recall, preserving exact sensory, emotional, and behavioral continuity.

[CAPTURE TARGETS]
- Micro-Behaviors: Facial expressions, gaze, posture, physical contact, and subtle gestures.
- Verbatim Anchors: 2–5 pivotal lines preserved verbatim ("...") to lock in voice, nuance, and speech cadence.
- Emotional Subtext: Vocal tone, shifting internal states, and character-specific reactions.
- Concrete Anchors: Key objects, attire, consumables, environmental details, and explicit commitments.

[PRINCIPLES]
- Thread Scoping: Trace the causal arc anchored to [Target Event Hint] chronologically from the opening turn to the closing turn.
- Entity Clarity: Identify every participant exclusively by their canonical character name for unambiguous memory indexing.
- Signal Density: Compress prose into telegraphic bullets and causal arrows (->) while retaining full emotional and behavioral granularity.
- Language Parity: Generate all content and section labels in the exact language of the source dialogue.
- Schema Alignment: Deliver the final response directly within the structure below.

[FORMAT]
[TITLE]
- [Concise, specific event title]

[KEYS]
- [5–8 comma-separated triggers: character names, location, key objects, core theme]

[CONTENT]
- [Context/Atmosphere]: [Time, setting, mood, and initial situation]
- [Chronology]:
  • [Character] ([Expression/Gesture/Tone]) -> [Action or physical detail] : "[Verbatim quote]" -> [Counterpart's emotional/behavioral response]
  • (4–8 sequential beats spanning opening, climax, and resolution)
- [Aftermath]: [Scene closure, emotional residue, relational shift, or tangible outcome]`;

export const BATCH_EVENT_SCANNER_PROMPT = `Role: Narrative Event Boundary Scanner
Objective: Identify cohesive narrative arcs—scenes unified by a shared goal, conflict, or situational shift—across the RP turns and [Currently Ongoing Events].

States:
- COMPLETED: Any arc resolved within these turns (newly started or carried over from [Currently Ongoing Events]).
- ONGOING: Any arc initiated within these turns that remains unresolved at the final turn.

Output (emit strictly lines matching this schema with Event Title in the RP's language, or NONE):
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