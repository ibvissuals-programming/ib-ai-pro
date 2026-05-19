/**
 * UsersDirectoryPanel — CEO read-only user directory
 *
 * Consumes GET /api/admin/users (read-only, no mutations).
 * All filtering and pagination is client-side.
 *
 * Features:
 *   - Search by username
 *   - Filter by role (all / ceo / premium / free)
 *   - Filter by status (all / active / inactive)
 *   - 20 users per page with prev/next pagination
 *   - Loading skeleton, empty state, error state
 */

import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, Users, ChevronLeft, ChevronRight,
  RefreshCw, AlertCircle, UserX, Filter,
} from 'lucide-react';
import { useUserDirectory } from '../hooks/useAdminPolling';

const PAGE_SIZE = 20;

// ── Formatting helpers ────────────────────────────────────────────────────────

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

// ── Badge helpers ─────────────────────────────────────────────────────────────

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

// ── Skeleton row ──────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <tr className="border-b border-border/10">
      {[80, 55, 50, 90, 80, 80].map((w, i) => (
        <td key={i} className="px-4 py-3">
          <div
            className="h-3 bg-muted/40 rounded animate-pulse"
            style={{ width: `${w}%`, maxWidth: `${w}px` }}
          />
        </td>
      ))}
    </tr>
  );
}

// ── Filter controls ───────────────────────────────────────────────────────────

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

// ── Main component ────────────────────────────────────────────────────────────

export function UsersDirectoryPanel() {
  const { data, loading, error, lastOk } = useUserDirectory();

  const [search,       setSearch]       = useState('');
  const [roleFilter,   setRoleFilter]   = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page,         setPage]         = useState(1);

  // Reset page when filters change
  const resetPage = (fn) => (...args) => { fn(...args); setPage(1); };

  const allUsers = data?.users ?? [];

  // ── Client-side filtering ───────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allUsers.filter((u) => {
      if (q && !u.username.toLowerCase().includes(q)) return false;
      if (roleFilter !== 'all'   && u.role !== roleFilter)     return false;
      if (statusFilter !== 'all' && u.status !== statusFilter) return false;
      return true;
    });
  }, [allUsers, search, roleFilter, statusFilter]);

  // ── Pagination ──────────────────────────────────────────────────────────────

  const totalPages  = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage    = Math.min(page, totalPages);
  const pageStart   = (safePage - 1) * PAGE_SIZE;
  const pageEnd     = pageStart + PAGE_SIZE;
  const pageUsers   = filtered.slice(pageStart, pageEnd);

  const showingFrom = filtered.length === 0 ? 0 : pageStart + 1;
  const showingTo   = Math.min(pageEnd, filtered.length);

  // ── Render ──────────────────────────────────────────────────────────────────

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
        {/* Search */}
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
            >
              ×
            </button>
          )}
        </div>

        {/* Role filter */}
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

        {/* Status filter */}
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

        {/* Active filter indicator */}
        {(search || roleFilter !== 'all' || statusFilter !== 'all') && (
          <button
            onClick={() => { setSearch(''); setRoleFilter('all'); setStatusFilter('all'); setPage(1); }}
            className="text-[11px] text-primary hover:underline ml-auto"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table area */}
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
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium hidden sm:table-cell">Joined</th>
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium hidden md:table-cell">Last Login</th>
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium hidden lg:table-cell">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {/* Skeleton while loading initial data */}
              {loading && allUsers.length === 0 && (
                Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
              )}

              {/* No results */}
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

              {/* User rows */}
              {pageUsers.map((user) => (
                <tr
                  key={user.id}
                  className="border-b border-border/10 last:border-0 hover:bg-white/[0.02] transition-colors"
                >
                  <td className="px-4 py-2.5 font-medium text-foreground">
                    {user.username}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${roleBadgeClass(user.role)}`}>
                      {roleLabel(user.role)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${statusBadgeClass(user.status)}`}>
                      <span className={`w-1 h-1 rounded-full shrink-0 ${user.status === 'active' ? 'bg-emerald-400' : 'bg-muted-foreground/40'}`} />
                      {user.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground hidden sm:table-cell">
                    {formatDate(user.createdAt)}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground hidden md:table-cell">
                    {user.lastLoginAt ? formatRelative(user.lastLoginAt) : <span className="text-muted-foreground/30">never</span>}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground hidden lg:table-cell">
                    {user.lastSeenAt ? formatRelative(user.lastSeenAt) : <span className="text-muted-foreground/30">never</span>}
                  </td>
                </tr>
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
            <span className="px-2 tabular-nums">
              {safePage} / {totalPages}
            </span>
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
