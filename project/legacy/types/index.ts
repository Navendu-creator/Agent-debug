export interface WorkflowNode {
  id: string;
  name: string;
  type: 'deterministic' | 'llm';
  description: string;
  icon: string;
  details: string[];
  model?: string;
  maxTurns?: number;
}

export interface ToolItem {
  name: string;
  category: string;
  description: string;
  freeAlternative: string;
  icon: string;
}

export interface TechStackItem {
  category: string;
  items: { name: string; purpose: string; free: boolean }[];
}

export interface RoadmapPhase {
  phase: number;
  title: string;
  description: string;
  items: string[];
  status: 'planned' | 'in-progress' | 'complete';
}

export interface EvidenceItem {
  id: string;
  timestamp: string;
  event: string;
  type: 'deployment' | 'error' | 'metric' | 'log' | 'restart';
  detail: string;
}

export interface AgentActivity {
  id: string;
  name: string;
  status: 'running' | 'complete' | 'pending' | 'failed';
  duration: string;
  findings: string;
}

export interface RcaFinding {
  id: string;
  type: 'OBSERVED' | 'INFERRED' | 'UNKNOWN';
  finding: string;
  evidence: string[];
  reasoning: string;
  confidence: number;
}

export interface MockIncident {
  id: string;
  title: string;
  severity: string;
  category: string;
  status: string;
  confidence: number;
  rootCause: string;
  service: string;
  environment: string;
  timeline: EvidenceItem[];
  agents: AgentActivity[];
  findings: RcaFinding[];
  suggestedFix: { action: string; risk: string; command: string; expectedResult: string };
  validation: { test: string; result: string; details: string };
}
