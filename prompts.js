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
Principle: Narrative threads run concurrently; evaluate each event's lifecycle independently across turns.

Task: Analyze [Recent Dialogue] against [Currently Ongoing Events].
- END: An ongoing event reaches a clear resolution, conclusion, or scene transition.
- START: A notable new scene, conflict, promise, activity, or subplot begins.

Output Specifications:
- Plain Text: Generate strictly raw, unformatted text matching the exact template below.
- Turn ID: Extract only the literal integer X from the corresponding "[Turn X]" header (indexing starts at 0).
- Event Title: For END, copy the exact title from [Currently Ongoing Events]. For START, write a concise title in the dialogue's primary language.
- Null State: If no event is detected for a category, output "NONE | NONE".

Output Template:
END: Exact Ongoing Title | 14
START: Concise New Event Title | 0

Fallback Template:
END: NONE | NONE
START: NONE | NONE`;

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
Task: Identify cohesive narrative arcs—scenes unified by a shared goal, conflict, or situational shift—across the RP turns and [Currently Ongoing Events].

Arc States:
- COMPLETED: Arcs resolved within these turns (newly started or resolved from [Currently Ongoing Events]).
- ONGOING: Arcs initiated within these turns that remain unresolved at the final turn.

[Principles & Output Schema]
- Direct Index Mapping: Extract the exact 0-based integer directly from each "[Turn X]" header, starting at 0 for the opening turn.
- Format Purity: Output strictly unformatted plain text. Represent turn boundaries solely as standalone integers and write titles in the RP's native language.
- Schema: Emit only lines matching these exact patterns (or output NONE):

COMPLETED: Event Title | 0 | 6
ONGOING: Event Title | 7`;

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