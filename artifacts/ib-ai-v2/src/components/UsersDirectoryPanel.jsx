/**
 * UsersDirectoryPanel — CEO user directory with credit + role management
 *
 * Read: GET /api/admin/users (polls every 30s)
 * Write:
 *   PATCH /api/admin/users/:userId/credits  — adjust credits by delta
 *   PATCH /api/admin/users/:userId/role     — set role (free | premium)
 *
 * Features:
 *   - Search by username
 *   - Filter by role / status
 *   - 20 users per page
 *   - Credits column with +7 / +20 / -5 quick-adjust buttons
 *   - Role toggle (Free ↔ Premium)
 *   - Optimistic local updates while API call is in flight
 *   - Per-row error display, non-crashing
 */

import { useState, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, Users, ChevronLeft, ChevronRight,
  RefreshCw, AlertCircle, UserX, Filter,
  Plus, Minus, Crown, AlertTriangle,
} from 'lucide-react';
import { useUserDirectory } from '../hooks/useAdminPolling';
import { getAuthHeaders } from '../auth/authService';

const PAGE_SIZE = 20;

const BASE = (() => {
  try { return (import.meta?.env?.BASE_URL ?? '').replace(/\/$/, ''); }
  catch { return ''; }
})();

// ── Formatting helpers ─────────────────────────────────────────────────────────

function formatDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString([], {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function formatRelative(ms) {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 5_000)     return 'just now';
  if (diff < 60_000)    return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return formatDate(ms);
}

function formatLastOk(ms) {
  if (!ms) return null;
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 3) return 'just now';
  return `${diff}s ago`;
}

// ── Badge helpers ──────────────────────────────────────────────────────────────

function roleBadgeClass(role) {
  if (role === 'ceo')     return 'text-purple-300 bg-purple-500/10 border-purple-500/25';
  if (role === 'premium') return 'text-blue-300   bg-blue-500/10   border-blue-500/25';
  return 'text-muted-foreground bg-muted/30 border-border/30';
}

function roleLabel(role) {
  if (role === 'ceo')     return 'CEO';
  if (role === 'premium') return 'Premium';
  return 'Free';
}

function statusBadgeClass(status) {
  return status === 'active'
    ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20'
    : 'text-muted-foreground bg-muted/20 border-border/20';
}

// ── Skeleton row ───────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <tr className="border-b border-border/10">
      {[80, 55, 50, 70, 80, 100].map((w, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-3 bg-muted/40 rounded animate-pulse" style={{ width: `${w}%`, maxWidth: `${w}px` }} />
        </td>
      ))}
    </tr>
  );
}

// ── Filter select ──────────────────────────────────────────────────────────────

function FilterSelect({ value, onChange, options, label }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="appearance-none glass-input rounded-lg pl-3 pr-7 py-1.5 text-xs text-foreground border border-border/40 bg-transparent cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary/50 hover:border-border/70 transition-colors"
      >
        {options.map(({ value: v, label: l }) => (
          <option key={v} value={v} className="bg-card text-foreground">{l}</option>
        ))}
      </select>
      <Filter size={10} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
    </div>
  );
}

// ── Credit adjust button ───────────────────────────────────────────────────────

function CreditBtn({ delta, pending, onClick }) {
  const isAdd = delta > 0;
  return (
    <button
      onClick={() => onClick(delta)}
      disabled={pending}
      title={`${isAdd ? 'Add' : 'Deduct'} ${Math.abs(delta)} credits`}
      className={`
        inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium border transition-colors
        disabled:opacity-40 disabled:cursor-not-allowed
        ${isAdd
          ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20 hover:bg-emerald-400/20'
          : 'text-red-400 bg-red-400/10 border-red-400/20 hover:bg-red-400/20'}
      `}
    >
      {isAdd ? <Plus size={8} /> : <Minus size={8} />}
      {Math.abs(delta)}
    </button>
  );
}

// ── User row ──────────────────────────────────────────────────────────────────

function UserRow({ user, overrides, pending, rowError, onCreditAdjust, onRoleChange }) {
  const credits = overrides?.credits ?? user.credits;
  const role    = overrides?.role    ?? user.role;
  const isCeo   = role === 'ceo';
  const isPending = pending === user.id;

  return (
    <>
      <tr className="border-b border-border/10 last:border-0 hover:bg-white/[0.02] transition-colors group">
        {/* Username */}
        <td className="px-4 py-2.5 font-medium text-foreground">
          {user.username}
        </td>

        {/* Role + toggle */}
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${roleBadgeClass(role)}`}>
              {roleLabel(role)}
            </span>
            {!isCeo && (
              <button
                onClick={() => onRoleChange(user.id, role === 'premium' ? 'free' : 'premium')}
                disabled={isPending}
                title={role === 'premium' ? 'Downgrade to Free' : 'Upgrade to Premium'}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Crown size={10} className={role === 'premium' ? 'text-muted-foreground' : 'text-blue-400'} />
              </button>
            )}
          </div>
        </td>

        {/* Status */}
        <td className="px-4 py-2.5">
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${statusBadgeClass(user.status)}`}>
            <span className={`w-1 h-1 rounded-full shrink-0 ${user.status === 'active' ? 'bg-emerald-400' : 'bg-muted-foreground/40'}`} />
            {user.status}
          </span>
        </td>

        {/* Credits + quick adjust */}
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-xs font-semibold tabular-nums ${isCeo ? 'text-purple-300' : credits <= 1 ? 'text-red-400' : 'text-foreground'}`}>
              {isCeo ? '∞' : credits}
            </span>
            {!isCeo && (
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <CreditBtn delta={+7}  pending={isPending} onClick={(d) => onCreditAdjust(user.id, d)} />
                <CreditBtn delta={+20} pending={isPending} onClick={(d) => onCreditAdjust(user.id, d)} />
                <CreditBtn delta={-5}  pending={isPending} onClick={(d) => onCreditAdjust(user.id, d)} />
              </div>
            )}
            {isPending && <RefreshCw size={10} className="text-muted-foreground animate-spin shrink-0" />}
          </div>
        </td>

        {/* Joined */}
        <td className="px-4 py-2.5 text-muted-foreground hidden sm:table-cell">
          {formatDate(user.createdAt)}
        </td>

        {/* Last Login */}
        <td className="px-4 py-2.5 text-muted-foreground hidden md:table-cell">
          {user.lastLoginAt ? formatRelative(user.lastLoginAt) : <span className="text-muted-foreground/30">never</span>}
        </td>
      </tr>

      {/* Inline error row */}
      {rowError && (
        <tr className="border-b border-border/10">
          <td colSpan={6} className="px-4 pb-2 pt-0">
            <div className="flex items-center gap-1.5 text-[10px] text-red-400/80">
              <AlertTriangle size={9} className="shrink-0" />
              {rowError}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function UsersDirectoryPanel() {
  const { data, loading, error, lastOk } = useUserDirectory();

  const [search,       setSearch]       = useState('');
  const [roleFilter,   setRoleFilter]   = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page,         setPage]         = useState(1);

  // Mutation state
  const [pending,    setPending]    = useState(null);         // userId in flight
  const [overrides,  setOverrides]  = useState({});           // { [userId]: { credits?, role? } }
  const [rowErrors,  setRowErrors]  = useState({});           // { [userId]: errorMessage }

  const resetPage = (fn) => (...args) => { fn(...args); setPage(1); };
  const allUsers  = data?.users ?? [];

  // ── Client-side filtering ────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allUsers.filter((u) => {
      const role   = overrides[u.id]?.role ?? u.role;
      const status = u.status;
      if (q && !u.username.toLowerCase().includes(q)) return false;
      if (roleFilter   !== 'all' && role   !== roleFilter)   return false;
      if (statusFilter !== 'all' && status !== statusFilter) return false;
      return true;
    });
  }, [allUsers, search, roleFilter, statusFilter, overrides]);

  // ── Pagination ───────────────────────────────────────────────────────────────

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const pageStart  = (safePage - 1) * PAGE_SIZE;
  const pageUsers  = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  // ── Mutations ────────────────────────────────────────────────────────────────

  const clearRowError = useCallback((userId) => {
    setRowErrors((e) => { const n = { ...e }; delete n[userId]; return n; });
  }, []);

  const handleCreditAdjust = useCallback(async (userId, delta) => {
    if (pending) return;
    setPending(userId);
    clearRowError(userId);

    // Optimistic update
    const current = overrides[userId]?.credits ?? allUsers.find((u) => u.id === userId)?.credits ?? 0;
    setOverrides((o) => ({ ...o, [userId]: { ...o[userId], credits: Math.max(0, current + delta) } }));

    try {
      const res = await fetch(`${BASE}/api/admin/users/${userId}/credits`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body:    JSON.stringify({ delta }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Revert optimistic update
        setOverrides((o) => { const n = { ...o }; delete n[userId]; return n; });
        setRowErrors((e) => ({ ...e, [userId]: json.error ?? `Server error (${res.status})` }));
      } else {
        // Confirm with server value
        setOverrides((o) => ({ ...o, [userId]: { ...o[userId], credits: json.credits } }));
      }
    } catch {
      setOverrides((o) => { const n = { ...o }; delete n[userId]; return n; });
      setRowErrors((e) => ({ ...e, [userId]: 'Network error — try again' }));
    } finally {
      setPending(null);
    }
  }, [pending, overrides, allUsers, clearRowError]);

  const handleRoleChange = useCallback(async (userId, newRole) => {
    if (pending) return;
    setPending(userId);
    clearRowError(userId);

    // Optimistic update
    setOverrides((o) => ({ ...o, [userId]: { ...o[userId], role: newRole } }));

    try {
      const res = await fetch(`${BASE}/api/admin/users/${userId}/role`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body:    JSON.stringify({ role: newRole }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setOverrides((o) => { const n = { ...o }; delete n[userId]; return n; });
        setRowErrors((e) => ({ ...e, [userId]: json.error ?? `Server error (${res.status})` }));
      }
    } catch {
      setOverrides((o) => { const n = { ...o }; delete n[userId]; return n; });
      setRowErrors((e) => ({ ...e, [userId]: 'Network error — try again' }));
    } finally {
      setPending(null);
    }
  }, [pending, clearRowError]);

  // ── Render ───────────────────────────────────────────────────────────────────

  const showingFrom = filtered.length === 0 ? 0 : pageStart + 1;
  const showingTo   = Math.min(pageStart + PAGE_SIZE, filtered.length);

  return (
    <div className="glass-card rounded-xl flex flex-col min-h-0">
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border/30">
        <div className="flex items-center gap-2">
          <Users size={14} className="text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground">
            User Directory
            {data && (
              <span className="ml-1.5 text-xs text-muted-foreground font-normal">
                ({data.count} total)
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {loading && <RefreshCw size={11} className="text-muted-foreground animate-spin" />}
          {lastOk && !loading && (
            <span className="text-[10px] text-muted-foreground/60 hidden sm:block">
              {formatLastOk(lastOk)}
            </span>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <div className="px-4 py-3 flex flex-wrap items-center gap-2 border-b border-border/20">
        <div className="relative flex-1 min-w-[140px] max-w-xs">
          <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search username…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="w-full glass-input rounded-lg pl-7 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 border border-border/40 bg-transparent focus:outline-none focus:ring-1 focus:ring-primary/50 hover:border-border/70 transition-colors"
          />
          {search && (
            <button
              onClick={() => { setSearch(''); setPage(1); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Clear search"
            >×</button>
          )}
        </div>

        <FilterSelect
          value={roleFilter}
          onChange={resetPage(setRoleFilter)}
          label="Filter by role"
          options={[
            { value: 'all',     label: 'All roles' },
            { value: 'ceo',     label: 'CEO' },
            { value: 'premium', label: 'Premium' },
            { value: 'free',    label: 'Free' },
          ]}
        />

        <FilterSelect
          value={statusFilter}
          onChange={resetPage(setStatusFilter)}
          label="Filter by status"
          options={[
            { value: 'all',      label: 'All status' },
            { value: 'active',   label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ]}
        />

        {(search || roleFilter !== 'all' || statusFilter !== 'all') && (
          <button
            onClick={() => { setSearch(''); setRoleFilter('all'); setStatusFilter('all'); setPage(1); }}
            className="text-[11px] text-primary hover:underline ml-auto"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Legend */}
      <div className="px-4 py-1.5 border-b border-border/10 text-[10px] text-muted-foreground/50 hidden sm:block">
        Hover a row to reveal credit (+7 / +20 / −5) and role controls
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {error && !loading ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center px-4">
            <AlertCircle size={20} className="text-amber-400/70" />
            <p className="text-sm text-muted-foreground">Unable to load users</p>
            <p className="text-xs text-muted-foreground/50">{error}</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/20">
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium">Username</th>
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium">Role</th>
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium">Status</th>
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium">Credits</th>
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium hidden sm:table-cell">Joined</th>
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium hidden md:table-cell">Last Login</th>
              </tr>
            </thead>
            <tbody>
              {loading && allUsers.length === 0 && (
                Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
              )}

              {!loading && filtered.length === 0 && !error && (
                <tr>
                  <td colSpan={6}>
                    <div className="flex flex-col items-center gap-2 py-16 text-center px-4">
                      <UserX size={20} className="text-muted-foreground/40" />
                      <p className="text-sm text-muted-foreground">
                        {allUsers.length === 0 ? 'No users found' : 'No users match your filters'}
                      </p>
                      {(search || roleFilter !== 'all' || statusFilter !== 'all') && (
                        <button
                          onClick={() => { setSearch(''); setRoleFilter('all'); setStatusFilter('all'); setPage(1); }}
                          className="text-xs text-primary hover:underline mt-1"
                        >
                          Clear filters
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )}

              {pageUsers.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  overrides={overrides[user.id]}
                  pending={pending}
                  rowError={rowErrors[user.id]}
                  onCreditAdjust={handleCreditAdjust}
                  onRoleChange={handleRoleChange}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination footer */}
      {!error && filtered.length > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-border/20 text-xs text-muted-foreground">
          <span>
            {showingFrom}–{showingTo} of {filtered.length} user{filtered.length !== 1 ? 's' : ''}
            {filtered.length < allUsers.length && (
              <span className="text-muted-foreground/50 ml-1">(filtered)</span>
            )}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="p-1 rounded hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              aria-label="Previous page"
            >
              <ChevronLeft size={13} />
            </button>
            <span className="px-2 tabular-nums">{safePage} / {totalPages}</span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              className="p-1 rounded hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              aria-label="Next page"
            >
              <ChevronRight size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
