// api.js - 서브 API 호출, 로컬/외부 벡터 계산, RAG 검색 및 프롬프트 주입
import { extension_settings, getContext } from "../../../extensions.js";
import { setExtensionPrompt, extension_prompt_types } from "../../../../script.js";
import { extensionName, PROMPT_KEY, isRoomEnabled, cleanMessageText } from "./state.js";

export async function callSubAPI(systemPrompt, userText) {
    const s = extension_settings[extensionName];
    if (!s.api_url || !s.api_key || !s.model) {
        throw new Error("서브 API 설정(URL, Key, Model)이 비어있습니다. 확장 프로그램 설정을 확인해주세요.");
    }

    const baseUrl = s.api_url.replace(/\/+$/, "");
    const endpoint = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;

    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${s.api_key}`
        },
        body: JSON.stringify({
            model: s.model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userText }
            ],
            temperature: 0.2
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API 오류 (${response.status}): ${errText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
}

export async function computeVector(text) {
    const s = extension_settings[extensionName];
    const clean = (text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
    if (!clean) return [];

    if (s.embed_model && s.api_url && s.api_key) {
        try {
            const baseUrl = s.api_url.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
            const res = await fetch(`${baseUrl}/embeddings`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${s.api_key}`
                },
                body: JSON.stringify({ model: s.embed_model, input: clean })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.data?.[0]?.embedding) return data.data[0].embedding;
            }
        } catch (e) {
            console.warn("[GM] 임베딩 API 호출 실패, 내장 로컬 벡터로 전환합니다:", e);
        }
    }

    const DIM = 256;
    const vec = new Array(DIM).fill(0);
    const compressed = clean.replace(/\s+/g, "");
    for (let i = 0; i < compressed.length - 1; i++) {
        const bg = compressed.slice(i, i + 2);
        let h = 2166136261;
        for (let j = 0; j < bg.length; j++) {
            h ^= bg.charCodeAt(j);
            h = Math.imul(h, 16777619);
        }
        vec[Math.abs(h) % DIM] += 1;
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vec.map(v => Number((v / norm).toFixed(4)));
}

export function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return (normA && normB) ? (dot / (Math.sqrt(normA) * Math.sqrt(normB))) : 0;
}

export async function retrieveRelevantEvents(gmData) {
    const events = gmData?.micro_events || [];
    if (events.length === 0) return [];

    const context = getContext();
    const chat = context?.chat || [];
    const recentText = chat.slice(-4).map(m => cleanMessageText(m.mes)).join(" ").toLowerCase();
    if (!recentText.trim()) return [];

    const queryVec = await computeVector(recentText);
    const topK = Number(extension_settings[extensionName].recall_top_k) || 3;

    const scored = [];
    for (let idx = 0; idx < events.length; idx++) {
        const ev = events[idx];
        ev.keys = Array.isArray(ev.keys) ? ev.keys : [];
        if (!ev.vector || ev.vector.length === 0) {
            ev.vector = await computeVector(`${ev.title || ""} ${ev.keys.join(" ")} ${ev.content || ""}`);
        }

        let matchedKeys = 0;
        for (const k of ev.keys) {
            if (k && recentText.includes(k.toLowerCase())) matchedKeys++;
        }
        if (ev.title && recentText.includes(ev.title.toLowerCase())) {
            matchedKeys++;
        }

        const keywordBonus = matchedKeys > 0 ? Math.min(0.6, matchedKeys * 0.25) : 0;
        const vecScore = cosineSimilarity(queryVec, ev.vector);
        const totalScore = Number((vecScore + keywordBonus).toFixed(3));

        ev._lastScore = totalScore;
        ev._recalled = false;
        scored.push({ ev, idx, totalScore });
    }

    const selected = scored
        .filter(item => item.totalScore >= 0.15)
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, topK);

    selected.forEach(item => { item.ev._recalled = true; });
    return selected.sort((a, b) => a.idx - b.idx).map(item => item.ev);
}

export async function injectMemoryPrompt(gmData) {
    if (!isRoomEnabled() || !gmData) {
        setExtensionPrompt(PROMPT_KEY, "", extension_prompt_types.BEFORE_PROMPT, 0);
        return;
    }

    const recalledEvents = await retrieveRelevantEvents(gmData);

    const parts = [];
    const fullMacro = [];
    if (gmData.macro_summary.trim()) fullMacro.push(gmData.macro_summary.trim());
    for (const c of (gmData.macro_chunks || [])) {
        if (c.content && c.content.trim()) fullMacro.push(`[Turns ${c.range}]\n${c.content.trim()}`);
    }
    if (fullMacro.length > 0) {
        parts.push(`[Story Summary So Far]\n${fullMacro.join("\n\n")}`);
    }

    if (recalledEvents.length > 0) {
        const recalledText = recalledEvents
            .map(ev => `• [${ev.title || "Event"} | Turns ${ev.startTurn}~${ev.endTurn} | Keys: ${(ev.keys || []).join(", ")}]\n${ev.content}`)
            .join("\n\n");
        parts.push(`[Recalled Detailed Past Events (Lorebook & Vector RAG)]\n${recalledText}`);
    }

    if (gmData.state.trim()) parts.push(`[Current Character & Relationship State]\n${gmData.state.trim()}`);
    if (gmData.open.trim()) parts.push(`[Active Promises & Unresolved Plots]\n${gmData.open.trim()}`);
    if (gmData.items.trim()) parts.push(`[Current Inventory]\n${gmData.items.trim()}`);

    if (parts.length === 0) {
        setExtensionPrompt(PROMPT_KEY, "", extension_prompt_types.BEFORE_PROMPT, 0);
        return;
    }

    const finalPrompt = `<genius_memory_context>\n${parts.join("\n\n")}\n</genius_memory_context>`;
    setExtensionPrompt(PROMPT_KEY, finalPrompt, extension_prompt_types.BEFORE_PROMPT, 0);
}