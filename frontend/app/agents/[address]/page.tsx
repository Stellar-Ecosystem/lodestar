'use client';

import { useEffect, useState, useCallback, ChangeEvent } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import type { AgentEntry, SpendingPolicy, Category } from '@/lib/types';
import { scoreTier, TIER_LABELS } from '@/lib/types';
import ScoreBadge from '@/components/ScoreBadge';
import SpendingPolicyDisplay from '@/components/SpendingPolicy';
import { fetchAgentEligibility } from '@/lib/contract';
import { useWallet } from '@/components/WalletContext';

const CATEGORY_OPTIONS: Category[] = ['weather', 'search', 'finance', 'ai', 'data', 'compute'];

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const EXPLORER_URL =
  process.env.NEXT_PUBLIC_EXPLORER_URL ?? 'https://stellar.expert/explorer/testnet';

const ACCESS_TIERS = [
  { label: 'Basic services', minScore: 0 },
  { label: 'Standard services', minScore: 300 },
  { label: 'Premium services', minScore: 600 },
  { label: 'Elite services', minScore: 900 },
];

export default function AgentProfilePage() {
  const { address } = useParams<{ address: string }>();
  const { address: walletAddress, status: walletStatus } = useWallet();
  const [agent, setAgent] = useState<AgentEntry | null>(null);
  const [policy, setPolicy] = useState<SpendingPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [customMinScore, setCustomMinScore] = useState(0);
  const [isEligible, setIsEligible] = useState<boolean | null>(null);
  const [checkingEligibility, setCheckingEligibility] = useState(false);

  const [editingPolicy, setEditingPolicy] = useState(false);
  const [policyForm, setPolicyForm] = useState({ maxPerTxUsdc: '', maxPerDayUsdc: '', minScoreToEarn: 0, allowedCategories: [] as Category[] });
  const [policySubmitting, setPolicySubmitting] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    try {
      const res = await fetch(`${API}/api/agents/${address}`);
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setAgent(data.agent ?? data);
        if (data.policy) setPolicy(data.policy);
      }
    } catch {
      setError('Could not reach the Lodestar backend');
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    load();
  }, [load]);

  function copyAddress() {
    if (!agent) return;
    navigator.clipboard.writeText(agent.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const checkEligibility = async () => {
    if (!address) return;
    setCheckingEligibility(true);
    try {
      const data = await fetchAgentEligibility(address, customMinScore);
      setIsEligible(data.eligible);
    } catch (err) {
      console.error('Failed to check eligibility:', err);
      setError('Failed to check eligibility');
    } finally {
      setCheckingEligibility(false);
    }
  };

  function openPolicyEdit() {
    if (!policy) return;
    const toUsdc = (stroops: string) => (Number(BigInt(stroops)) / 10_000_000).toString();
    setPolicyForm({
      maxPerTxUsdc: toUsdc(policy.max_per_tx_stroops),
      maxPerDayUsdc: policy.max_per_day_stroops === '0' ? '0' : toUsdc(policy.max_per_day_stroops),
      minScoreToEarn: policy.min_score_to_earn,
      allowedCategories: (policy.allowed_categories as Category[]).filter(c => CATEGORY_OPTIONS.includes(c)),
    });
    setPolicyError(null);
    setEditingPolicy(true);
  }

  async function submitPolicyEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!address || !walletAddress) return;
    setPolicySubmitting(true);
    setPolicyError(null);
    try {
      const toStroops = (usdc: string) => String(Math.round(parseFloat(usdc) * 10_000_000));
      const res = await fetch(`${API}/api/agents/${address}/policy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-caller-address': walletAddress },
        body: JSON.stringify({
          maxPerTxStroops: toStroops(policyForm.maxPerTxUsdc),
          maxPerDayStroops: policyForm.maxPerDayUsdc === '0' ? '0' : toStroops(policyForm.maxPerDayUsdc),
          allowedCategories: policyForm.allowedCategories,
          minScoreToEarn: policyForm.minScoreToEarn,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Update failed (${res.status})`);
      await load();
      setEditingPolicy(false);
    } catch (err) {
      setPolicyError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setPolicySubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="card p-8 h-64 animate-pulse bg-border/40 mb-6" />
        <div className="card p-8 h-40 animate-pulse bg-border/40" />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-24 text-center">
        <p className="text-error text-sm mb-4">{error ?? 'Agent not found'}</p>
        <Link href="/agents" className="btn-secondary px-5 py-2.5 text-sm">
          Back to agents
        </Link>
      </div>
    );
  }

  const successRate =
    agent.total_payments > 0
      ? Math.round((agent.successful_payments / agent.total_payments) * 100)
      : null;

  const tier = scoreTier(agent.score);
  const totalVolumeUsdc = (Number(BigInt(agent.total_volume_stroops)) / 10_000_000).toFixed(4);

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <Link
        href="/agents"
        className="text-sm text-secondary hover:text-primary transition-colors mb-8 inline-block"
      >
        ← All agents
      </Link>

      {/* Profile header */}
      <div className="card p-8 mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight mb-2">{agent.name}</h1>
            <div className="flex items-center gap-2 flex-wrap">
              <a
                href={`${EXPLORER_URL}/account/${agent.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mono text-sm text-secondary hover:text-primary transition-colors truncate"
              >
                {agent.address}
              </a>
              <button
                onClick={copyAddress}
                className="text-xs text-secondary hover:text-primary transition-colors shrink-0"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
          <ScoreBadge score={agent.score} size="md" />
        </div>

        <p className="text-sm text-secondary leading-relaxed mb-6">{agent.description}</p>

        {/* Flagged / inactive banner */}
        {(agent.flagged || !agent.active) && (
          <div className="bg-error/5 border border-error/20 rounded-lg px-4 py-3 mb-6">
            {agent.flagged && (
              <p className="text-sm text-error font-medium">
                Flagged: {agent.flag_reason || 'No reason provided'}
              </p>
            )}
            {!agent.active && !agent.flagged && (
              <p className="text-sm text-secondary">This agent has been deactivated.</p>
            )}
          </div>
        )}

        {/* Score bar */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-secondary">Credit score</span>
            <span className="mono text-sm font-semibold">{agent.score} / 1000</span>
          </div>
          <div className="w-full bg-border rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${
                tier === 'elite'
                  ? 'bg-amber-500'
                  : tier === 'trusted'
                  ? 'bg-emerald-500'
                  : tier === 'established'
                  ? 'bg-violet-500'
                  : tier === 'building'
                  ? 'bg-blue-500'
                  : 'bg-gray-400'
              }`}
              style={{ width: `${(agent.score / 1000) * 100}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-secondary mt-1.5">
            <span>New</span>
            <span>Building</span>
            <span>Established</span>
            <span>Trusted</span>
            <span>Elite</span>
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total payments" value={agent.total_payments.toLocaleString()} />
          <StatCard
            label="Successful"
            value={agent.successful_payments.toLocaleString()}
            color="success"
          />
          <StatCard
            label="Failed"
            value={agent.failed_payments.toLocaleString()}
            color={agent.failed_payments > 0 ? 'error' : undefined}
          />
          <StatCard
            label="Success rate"
            value={successRate !== null ? `${successRate}%` : '—'}
            color={successRate !== null && successRate >= 90 ? 'success' : undefined}
          />
        </div>
      </div>

      {/* Spending policy */}
      {policy && (
        <div className="mb-6">
          <SpendingPolicyDisplay policy={policy} />
          {walletStatus === 'connected' && walletAddress === agent.owner && !editingPolicy && (
            <button onClick={openPolicyEdit} className="mt-3 btn-secondary text-sm px-4 py-2">
              Edit Policy
            </button>
          )}
          {editingPolicy && (
            <form onSubmit={submitPolicyEdit} className="card p-6 mt-3 flex flex-col gap-4">
              <h3 className="font-semibold text-sm">Edit Spending Policy</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-secondary mb-1">Max per transaction (USDC)</label>
                  <input type="number" min="0.000001" step="0.000001" value={policyForm.maxPerTxUsdc}
                    onChange={e => setPolicyForm(f => ({ ...f, maxPerTxUsdc: e.target.value }))}
                    className="input w-full text-sm" required />
                </div>
                <div>
                  <label className="block text-xs text-secondary mb-1">Max per day (USDC, 0 = no limit)</label>
                  <input type="number" min="0" step="0.000001" value={policyForm.maxPerDayUsdc}
                    onChange={e => setPolicyForm(f => ({ ...f, maxPerDayUsdc: e.target.value }))}
                    className="input w-full text-sm" required />
                </div>
                <div>
                  <label className="block text-xs text-secondary mb-1">Min score to earn</label>
                  <input type="number" min="0" max="1000" value={policyForm.minScoreToEarn}
                    onChange={e => setPolicyForm(f => ({ ...f, minScoreToEarn: Number(e.target.value) }))}
                    className="input w-full text-sm" required />
                </div>
              </div>
              <div>
                <label className="block text-xs text-secondary mb-2">Allowed categories (empty = all)</label>
                <div className="flex flex-wrap gap-2">
                  {CATEGORY_OPTIONS.map(cat => (
                    <button key={cat} type="button"
                      onClick={() => setPolicyForm(f => ({ ...f, allowedCategories: f.allowedCategories.includes(cat) ? f.allowedCategories.filter(c => c !== cat) : [...f.allowedCategories, cat] }))}
                      className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${policyForm.allowedCategories.includes(cat) ? 'bg-accent text-white border-accent' : 'border-border text-secondary hover:border-accent hover:text-primary'}`}>
                      {cat}
                    </button>
                  ))}
                </div>
              </div>
              {policyError && <p className="text-sm text-error">{policyError}</p>}
              <div className="flex gap-3">
                <button type="submit" disabled={policySubmitting} className="btn-primary text-sm disabled:opacity-50">
                  {policySubmitting ? 'Saving…' : 'Save Policy'}
                </button>
                <button type="button" onClick={() => setEditingPolicy(false)} className="btn-secondary text-sm">Cancel</button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Access level */}
      <div className="card p-6 mb-6">
        <h3 className="font-semibold text-base mb-4">Access Level</h3>
        <div className="space-y-2">
          {ACCESS_TIERS.map(({ label, minScore }) => {
            const eligible = agent.score >= minScore;
            return (
              <div key={minScore} className="flex items-center gap-3">
                <span className={`text-sm ${eligible ? 'text-success' : 'text-secondary'}`}>
                  {eligible ? '✓' : '○'}
                </span>
                <span className={`text-sm ${eligible ? 'text-primary' : 'text-secondary'}`}>
                  {label}
                </span>
                <span className="mono text-xs text-secondary ml-auto">score {minScore}+</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Custom Eligibility Check */}
      <div className="card p-6 mb-6">
        <h3 className="font-semibold text-base mb-4">Custom Eligibility Check</h3>
        <p className="text-sm text-secondary mb-4">
          Verify if this agent meets a specific minimum credit score requirement.
        </p>
        <div className="flex flex-wrap gap-3">
          <input
            type="number"
            value={customMinScore}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setCustomMinScore(Number(e.target.value));
              setIsEligible(null);
            }}
            placeholder="Min score"
            className="input w-36"
            min="0"
            max="1000"
          />
          <button
            onClick={checkEligibility}
            disabled={checkingEligibility}
            className="btn-primary"
          >
            {checkingEligibility ? 'Checking...' : 'Check Eligibility'}
          </button>
        </div>
        {isEligible !== null && !checkingEligibility && (
          <div className={`mt-4 p-3 rounded-lg border flex items-center gap-3 fade-in ${
            isEligible ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-600' : 'bg-red-500/5 border-red-500/20 text-red-600'
          }`}>
            <span className="text-lg font-bold">{isEligible ? '✓' : '×'}</span>
            <span className="text-sm font-medium">
              {isEligible 
                ? `Agent is ELIGIBLE for services requiring a score of ${customMinScore}+` 
                : `Agent is NOT ELIGIBLE for services requiring a score of ${customMinScore}+`}
            </span>
          </div>
        )}
      </div>

      {/* Metadata */}
      <div className="card p-5 flex flex-wrap gap-6">
        <MetaItem label="Tier" value={TIER_LABELS[tier]} />
        <MetaItem label="Total volume" value={`$${totalVolumeUsdc} USDC`} />
        <MetaItem label="Registered at ledger" value={`#${agent.registered_at.toLocaleString()}`} />
        <MetaItem label="Last active at ledger" value={`#${agent.last_active.toLocaleString()}`} />
        <MetaItem label="Owner" value={`${agent.owner.slice(0, 6)}…${agent.owner.slice(-4)}`} mono />
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: 'success' | 'error';
}) {
  return (
    <div className="bg-background rounded-lg px-4 py-3 border border-border text-center">
      <div
        className={`mono text-lg font-semibold ${
          color === 'success' ? 'text-success' : color === 'error' ? 'text-error' : 'text-primary'
        }`}
      >
        {value}
      </div>
      <div className="text-xs text-secondary mt-0.5">{label}</div>
    </div>
  );
}

function MetaItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs text-secondary mb-0.5">{label}</div>
      <div className={`text-sm font-medium ${mono ? 'mono' : ''}`}>{value}</div>
    </div>
  );
}
