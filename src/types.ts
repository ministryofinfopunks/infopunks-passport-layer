import { z } from "zod";

export const SubjectTypeSchema = z.enum(["agent", "human", "endpoint", "wallet", "project"]);
export const PassportStatusSchema = z.enum(["unproven", "watch", "verified", "preferred", "restricted", "revoked"]);

export const RegisterPassportSchema = z.object({
  subject_type: SubjectTypeSchema,
  display_name: z.string().min(1),
  wallet: z.string().min(1),
  domains: z.array(z.string().min(1)).default([]),
  endpoint_url: z.string().url().optional(),
  operator: z.object({
    type: z.enum(["human", "project", "dao", "company"]),
    name: z.string().min(1)
  }).optional(),
  claims: z.array(z.object({
    type: z.enum(["capability", "domain", "identity", "external_reference"]),
    value: z.string().min(1)
  })).optional()
});

export const AttestSchema = z.object({
  passport_id: z.string().min(1),
  attestation_type: z.enum(["capability", "task_success", "task_failure", "domain", "dispute", "external_reference"]),
  domain: z.string().min(1).optional(),
  summary: z.string().min(3),
  evidence_url: z.string().url().optional(),
  confidence: z.number().min(0).max(1).optional(),
  issuer: z.string().min(1).optional()
});

export const VerifyClaimSchema = z.object({
  claim: z.string(),
  context: z.string(),
  requested_depth: z.enum(["light", "standard", "deep"]),
  risk_mode: z.enum(["narrative", "market", "technical", "general"])
});

export const RouteAgentSchema = z.object({
  task: z.string().min(1),
  context: z.object({
    market: z.string().optional(),
    chain: z.string().optional(),
    urgency: z.enum(["low", "medium", "high"]).optional(),
    domain: z.string().optional()
  }).optional(),
  candidates: z.array(z.object({
    agent_id: z.string().optional(),
    passport_id: z.string().optional(),
    wallet: z.string().optional(),
    domains: z.array(z.string()).optional(),
    trust_score: z.number().optional(),
    evidence_count: z.number().optional(),
    status: PassportStatusSchema.optional()
  })).min(1),
  budget: z.object({
    amount: z.string(),
    asset: z.literal("USDC")
  }),
  risk_tolerance: z.enum(["low", "medium", "high"]),
  policy: z.object({
    minimum_trust_score: z.number(),
    require_recent_evidence: z.boolean(),
    prefer_domain_fit: z.boolean(),
    allow_unproven_agents: z.boolean()
  })
});

export type RegisterPassportInput = z.infer<typeof RegisterPassportSchema>;
export type AttestInput = z.infer<typeof AttestSchema>;
export type VerifyClaimInput = z.infer<typeof VerifyClaimSchema>;
export type RouteAgentInput = z.infer<typeof RouteAgentSchema>;
export type PassportStatus = z.infer<typeof PassportStatusSchema>;

export interface PassportRecord {
  passport_id: string;
  subject_type: RegisterPassportInput["subject_type"];
  display_name: string;
  wallet: string;
  domains: string[];
  endpoint_url?: string;
  operator?: RegisterPassportInput["operator"];
  trust_score: number;
  evidence_count: number;
  claim_count: number;
  last_verified: string;
  status: PassportStatus;
  passport_url: string;
}

export interface PaymentVerification {
  verified: true;
  provider: string;
  reference: string;
}

export interface PublicReceipt {
  receipt_id: string;
  endpoint: string;
  paid_resource: string;
  timestamp: string;
  input_hash: string;
  output_hash: string;
  x402_verified: true;
  network: string;
  asset: string;
  facilitator_provider: string;
  status: 200;
}

export interface PublicEvent {
  event_id: string;
  event_type: "paid_call.success" | "passport.registered" | "passport.attested" | "claim.verified" | "route.decided";
  receipt_id: string;
  endpoint: string;
  timestamp: string;
}
