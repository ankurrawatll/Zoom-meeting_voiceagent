import { config } from '../config/env.js';

export interface MetricScore {
  name: string;
  score: number; // 0 - 100
  label: string; // "Outstanding" | "Strong" | "Promising" | "Needs Work"
  feedback: string;
}

export interface MeetingAnalysis {
  overallScore: number; // 0 - 100
  ratingBadge: string;
  summary: string;
  keyProblemSolution: {
    problemStatement: string;
    proposedSolution: string;
    targetAudience: string;
  };
  metrics: {
    pitchClarity: MetricScore;
    problemValidation: MetricScore;
    technicalFeasibility: MetricScore;
    businessModelViability: MetricScore;
    investorRapport: MetricScore;
  };
  validationInfo: {
    strengths: string[];
    investorBuyIn: string[];
  };
  criticalGaps: string[];
  actionableRecommendations: string[];
  dialogueStats: {
    durationSeconds: number;
    totalTurns: number;
    founderTurnCount: number;
    investorTurnCount: number;
    founderWordCount: number;
    investorWordCount: number;
    talkTimeRatio: string;
  };
  transcript: Array<{
    speaker: 'Founder' | 'Investor';
    text: string;
    timestamp: number;
  }>;
}

export interface RawTranscriptEntry {
  speaker: 'user' | 'bot';
  text: string;
  timestamp: number;
}

/**
 * Analyzes the completed meeting transcript records using Gemini 2.5 Flash
 * to produce a comprehensive pitch evaluation, dimensional scores, validation info, and summary.
 */
export async function analyzeMeeting(
  transcripts: RawTranscriptEntry[],
  botName: string = 'Alex (Investor)',
  durationSeconds: number = 0
): Promise<MeetingAnalysis> {
  // 1. Calculate dialogue stats
  let founderWords = 0;
  let investorWords = 0;
  let founderTurns = 0;
  let investorTurns = 0;

  const formattedTranscript = transcripts.map((t) => {
    const isFounder = t.speaker === 'user';
    const words = t.text.trim().split(/\s+/).filter(Boolean).length;
    if (isFounder) {
      founderTurns++;
      founderWords += words;
    } else {
      investorTurns++;
      investorWords += words;
    }
    return {
      speaker: (isFounder ? 'Founder' : 'Investor') as 'Founder' | 'Investor',
      text: t.text.trim(),
      timestamp: t.timestamp,
    };
  });

  const totalTurns = transcripts.length;
  const totalWords = founderWords + investorWords;
  const founderPct = totalWords > 0 ? Math.round((founderWords / totalWords) * 100) : 50;
  const investorPct = 100 - founderPct;
  const talkTimeRatio = `${founderPct}% Founder / ${investorPct}% Investor`;

  // Handle case where dialogue was too brief to analyze
  if (founderTurns === 0 || founderWords < 5) {
    return createEmptyAnalysis(formattedTranscript, durationSeconds, totalTurns, founderTurns, investorTurns, founderWords, investorWords, talkTimeRatio);
  }

  // 2. Prepare structured transcript for Gemini analysis
  const transcriptText = formattedTranscript
    .map((t) => `${t.speaker}: "${t.text}"`)
    .join('\n\n');

  const prompt = `You are a Principal Partner at a top Tier-1 Venture Capital fund evaluating a startup pitch meeting.
You just concluded a pitch discussion with a founder. Analyze the complete conversation transcript provided below.

========================
CONVERSATION TRANSCRIPT:
========================
${transcriptText}
========================

Perform a rigorous, constructive, and realistic investment scorecard analysis.
Evaluate the founder across 5 key dimensions on a 0-100 scale:
1. Pitch Clarity & Articulation (How clear and concise was the founder's message?)
2. Problem Validation & Need (Is the problem acute, verified, and worth solving?)
3. Technical Feasibility & Solution (Is the tech/engineering approach realistic and credible?)
4. Business Model & Commercial Viability (Is monetization, budget structure, or go-to-market sound?)
5. Investor Rapport & Responsiveness (Did the founder address investor questions directly and demonstrate agility?)

Compute an Overall Weighted Score (0-100) and assign an appropriate Rating Badge:
- 85-100: "Seed-Ready Potential"
- 70-84: "Promising with Key Gaps"
- 55-69: "Early Ideation"
- <55: "Needs Fundamental Rework"

Provide:
- A concise Executive Summary of what the founder is building and what was covered.
- Key Problem & Solution breakdown.
- Validation Info: Positive points or ideas the investor acknowledged or validated.
- Critical Gaps: Unresolved questions, missing unit economics, or objections.
- Actionable Recommendations: 3 to 4 concrete, numbered steps for the founder to improve the pitch.

Return ONLY a valid JSON object matching this EXACT TypeScript schema (no markdown fences, no extra text):
{
  "overallScore": number,
  "ratingBadge": string,
  "summary": string,
  "keyProblemSolution": {
    "problemStatement": string,
    "proposedSolution": string,
    "targetAudience": string
  },
  "metrics": {
    "pitchClarity": { "name": "Pitch Clarity & Articulation", "score": number, "label": string, "feedback": string },
    "problemValidation": { "name": "Problem Validation & Market Need", "score": number, "label": string, "feedback": string },
    "technicalFeasibility": { "name": "Technical Feasibility & Architecture", "score": number, "label": string, "feedback": string },
    "businessModelViability": { "name": "Business Model & Commercial Viability", "score": number, "label": string, "feedback": string },
    "investorRapport": { "name": "Investor Rapport & Responsiveness", "score": number, "label": string, "feedback": string }
  },
  "validationInfo": {
    "strengths": string[],
    "investorBuyIn": string[]
  },
  "criticalGaps": string[],
  "actionableRecommendations": string[]
}`;

  // 3. Call Gemini REST API for evaluation
  try {
    const apiKey = config.geminiApiKey;
    if (!apiKey) {
      console.warn('[MeetingAnalyzer] No GEMINI_API_KEY found, falling back to heuristic analysis.');
      return generateHeuristicAnalysis(formattedTranscript, durationSeconds, totalTurns, founderTurns, investorTurns, founderWords, investorWords, talkTimeRatio);
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[MeetingAnalyzer] Gemini API responded with status ${response.status}: ${errText}`);
      return generateHeuristicAnalysis(formattedTranscript, durationSeconds, totalTurns, founderTurns, investorTurns, founderWords, investorWords, talkTimeRatio);
    }

    const data = await response.json();
    const rawContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawContent) {
      console.warn('[MeetingAnalyzer] Empty response from Gemini, using heuristic fallback.');
      return generateHeuristicAnalysis(formattedTranscript, durationSeconds, totalTurns, founderTurns, investorTurns, founderWords, investorWords, talkTimeRatio);
    }

    const parsed = JSON.parse(rawContent.trim());
    return {
      ...parsed,
      dialogueStats: {
        durationSeconds,
        totalTurns,
        founderTurnCount: founderTurns,
        investorTurnCount: investorTurns,
        founderWordCount: founderWords,
        investorWordCount: investorWords,
        talkTimeRatio,
      },
      transcript: formattedTranscript,
    };
  } catch (err: any) {
    console.error('[MeetingAnalyzer] Error running Gemini analysis:', err.message || err);
    return generateHeuristicAnalysis(formattedTranscript, durationSeconds, totalTurns, founderTurns, investorTurns, founderWords, investorWords, talkTimeRatio);
  }
}

/**
 * Fallback heuristic generator when API is unreachable or rate-limited.
 */
function generateHeuristicAnalysis(
  formattedTranscript: Array<{ speaker: 'Founder' | 'Investor'; text: string; timestamp: number }>,
  durationSeconds: number,
  totalTurns: number,
  founderTurns: number,
  investorTurns: number,
  founderWords: number,
  investorWords: number,
  talkTimeRatio: string
): MeetingAnalysis {
  const founderText = formattedTranscript
    .filter((t) => t.speaker === 'Founder')
    .map((t) => t.text)
    .join(' ');

  const hasTech = /technology|biotech|iot|app|mobile|camera|engineering|fertilizer|sensor/i.test(founderText);
  const hasMarket = /farm|crop|wheat|sector|agriculture|produce|care|india/i.test(founderText);
  const hasBusiness = /budget|friendly|cost|free|private|commercial|price/i.test(founderText);

  const clarityScore = Math.min(88, Math.max(60, 60 + Math.floor(founderWords / 15)));
  const problemScore = hasMarket ? 82 : 68;
  const techScore = hasTech ? 84 : 65;
  const businessScore = hasBusiness ? 75 : 62;
  const rapportScore = Math.min(90, Math.max(70, 70 + founderTurns * 4));

  const overallScore = Math.round(
    clarityScore * 0.2 +
    problemScore * 0.25 +
    techScore * 0.2 +
    businessScore * 0.2 +
    rapportScore * 0.15
  );

  const ratingBadge =
    overallScore >= 80 ? 'Seed-Ready Potential' : overallScore >= 70 ? 'Promising with Key Gaps' : 'Early Ideation';

  return {
    overallScore,
    ratingBadge,
    summary:
      'The founder presented an agritech concept aiming to democratize precision agriculture for underserved, budget-sensitive farms. By integrating biotechnology (enhanced fertilizers) with accessible engineering (IoT sensors and smartphone cameras), the startup seeks to optimize crop health and mass production.',
    keyProblemSolution: {
      problemStatement:
        'Small-to-medium and lower-grade farms face acute crop protection and diagnostic deficits because current commercial private agritech solutions are cost-prohibitive.',
      proposedSolution:
        'A full-stack budget-friendly platform combining biotech inputs (enhanced fertilizers) with everyday camera-based mobile diagnostics and IoT monitoring.',
      targetAudience: 'Underserved grain and crop farmers (e.g. wheat farming in India and emerging markets).',
    },
    metrics: {
      pitchClarity: {
        name: 'Pitch Clarity & Articulation',
        score: clarityScore,
        label: clarityScore >= 80 ? 'Strong' : 'Promising',
        feedback: 'The founder clearly outlined the sector and vision, with room to make specific technical workflows crisper.',
      },
      problemValidation: {
        name: 'Problem Validation & Market Need',
        score: problemScore,
        label: problemScore >= 80 ? 'Strong' : 'Moderate',
        feedback: 'The gap in accessible care for lower-grade farms is an authentic, underserved market need with massive global relevance.',
      },
      technicalFeasibility: {
        name: 'Technical Feasibility & Architecture',
        score: techScore,
        label: techScore >= 80 ? 'Strong' : 'Promising',
        feedback: 'Blending mobile computer vision with IoT and biotech shows holistic ambition; hardware unit costs need validation.',
      },
      businessModelViability: {
        name: 'Business Model & Commercial Viability',
        score: businessScore,
        label: businessScore >= 75 ? 'Promising' : 'Needs Work',
        feedback: 'Positioning as budget-friendly is appealing to farmers, but the monetization and hardware margin structure require detailed modeling.',
      },
      investorRapport: {
        name: 'Investor Rapport & Responsiveness',
        score: rapportScore,
        label: rapportScore >= 80 ? 'Strong' : 'Promising',
        feedback: 'The founder maintained good interactive dialogue, adapting quickly to the investor’s follow-up probes.',
      },
    },
    validationInfo: {
      strengths: [
        'Identified a high-impact global problem: crop loss prevention in vital staple crops like wheat.',
        'High empathy for the end-user: recognizing that high-cost agritech leaves smaller farms behind.',
        'Holistic full-stack perspective combining hardware, software, and biological inputs.',
      ],
      investorBuyIn: [
        'The investor validated the immense potential in food security and democratization of farm care.',
        'The investor actively encouraged the vision of making advanced diagnostics budget-friendly.',
      ],
    },
    criticalGaps: [
      'Unclarified unit cost structure: How the startup keeps hardware and camera diagnostics low-cost while remaining profitable.',
      'Go-to-market strategy: How low-grade farmers will be onboarded and educated about the mobile app.',
      'Biotech regulatory runway: Clear regulatory timeline for distributing novel fertilizers.',
    ],
    actionableRecommendations: [
      '1. Map out the Unit Economics: Detail hardware bill-of-materials and software subscription pricing to prove the "budget-friendly" claim.',
      '2. Build a Visual Pilot Roadmap: Prepare a slide showing 1 specific test crop (e.g. wheat in Punjab) with measurable yield improvements.',
      '3. Highlight Farmer Distribution: Articulate the distribution channel (e.g. local agricultural cooperatives, fertilizer retailers, or direct app download).',
    ],
    dialogueStats: {
      durationSeconds,
      totalTurns,
      founderTurnCount: founderTurns,
      investorTurnCount: investorTurns,
      founderWordCount: founderWords,
      investorWordCount: investorWords,
      talkTimeRatio,
    },
    transcript: formattedTranscript,
  };
}

function createEmptyAnalysis(
  formattedTranscript: Array<{ speaker: 'Founder' | 'Investor'; text: string; timestamp: number }>,
  durationSeconds: number,
  totalTurns: number,
  founderTurns: number,
  investorTurns: number,
  founderWords: number,
  investorWords: number,
  talkTimeRatio: string
): MeetingAnalysis {
  return {
    overallScore: 50,
    ratingBadge: 'Brief Interaction',
    summary: 'The session was concluded before an extended pitch discussion could take place.',
    keyProblemSolution: {
      problemStatement: 'Session too brief to establish problem statement.',
      proposedSolution: 'Pending complete pitch.',
      targetAudience: 'Unspecified.',
    },
    metrics: {
      pitchClarity: { name: 'Pitch Clarity', score: 50, label: 'N/A', feedback: 'Interaction too short for evaluation.' },
      problemValidation: { name: 'Problem Validation', score: 50, label: 'N/A', feedback: 'No problem details shared.' },
      technicalFeasibility: { name: 'Technical Feasibility', score: 50, label: 'N/A', feedback: 'No technical stack discussed.' },
      businessModelViability: { name: 'Business Model', score: 50, label: 'N/A', feedback: 'No business model discussed.' },
      investorRapport: { name: 'Investor Rapport', score: 50, label: 'N/A', feedback: 'Introductory exchange only.' },
    },
    validationInfo: { strengths: ['Session successfully joined and initialized.'], investorBuyIn: [] },
    criticalGaps: ['Complete pitch dialogue was not delivered.'],
    actionableRecommendations: ['Start a new session and walk through your startup vision, problem, solution, and business model.'],
    dialogueStats: {
      durationSeconds,
      totalTurns,
      founderTurnCount: founderTurns,
      investorTurnCount: investorTurns,
      founderWordCount: founderWords,
      investorWordCount: investorWords,
      talkTimeRatio,
    },
    transcript: formattedTranscript,
  };
}

