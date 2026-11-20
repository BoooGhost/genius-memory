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


export const EVENT_DETECTOR_PROMPT = `Role: Granular Narrative Scene Boundary Detector.
Objective: Segment [Recent Dialogue] against [Currently Ongoing Events] into immediate, self-contained scenes, actively closing micro-beats as they resolve.

[TRANSITION PRINCIPLES]
1. CONCLUDE (END) an ongoing event when ANY condition is met:
   - Resolution: The immediate action, interaction, or tension reaches an outcome or pause.
   - Context Shift: Time, location, activity, or conversational focus changes.
   - Pacing: The event spans 10+ turns and reaches a natural narrative pause.

2. INITIATE (START) a new event when:
   - A distinct narrative focus, activity, or dynamic establishes itself (often immediately following an END).

[OUTPUT SPECIFICATION]
Output strictly two lines of unformatted plain text using the exact schema below.
- END Identifier: Copy the exact ID and Title verbatim from [Currently Ongoing Events] at its concluding turn.
- START Identifier: Write a concise title in the dialogue's primary language.
- Turn Number: Extract the pure integer X from the "[Turn X]" tag marking the boundary.
- Fallback: Use "NONE | NONE" if no transition occurs on that line.

END: #1 Exact Ongoing Title | 7
START: New Scene Title | 8

(If nothing ended: END: NONE | NONE)
(If nothing started: START: NONE | NONE)`;

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