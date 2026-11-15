import type { HubStatus, SessionId } from '@orfoni/protocol';

type Plan = HubStatus['plan'];
type PlanWindow = NonNullable<Plan>['fiveHour'];
type Reports = Record<WindowName, PlanWindow>;

const WINDOWS = ['fiveHour', 'sevenDay'] as const;
type WindowName = (typeof WINDOWS)[number];

function sameWindow(a: PlanWindow, b: PlanWindow): boolean {
	return a === b || (a !== null && b !== null && a.usedPercent === b.usedPercent && a.resetsAt === b.resetsAt);
}

// Claude Code learns the plan windows when it starts and with each reply, and its status line repeats them every 10 s, so an idle session goes on reporting what it saw at its last turn. A window's share can also drop without its reset time moving, as when Anthropic grants a reset. So the usage shown is the one a Claude Code heard of last, which is a report that differs from what the same session reported before. A session that stops reporting a window, as one does once the window has run out, leaves it as it was.
export class PlanUsage {
	private known: Record<WindowName, { window: NonNullable<PlanWindow>; seenAt: number } | null> = { fiveHour: null, sevenDay: null };
	// What each session's Claude Code reported last of each window. A session missing here runs a Claude Code from before the hub started, so the hub does not know when it heard of what it reports first.
	private readonly lastReports = new Map<SessionId, Reports>();

	get plan(): Plan {
		const { fiveHour, sevenDay } = this.known;
		return fiveHour === null && sevenDay === null ? null : { fiveHour: fiveHour?.window ?? null, sevenDay: sevenDay?.window ?? null };
	}

	// The hub starts a Claude Code, which has reported nothing yet.
	started(sessionId: SessionId): void {
		this.lastReports.set(sessionId, { fiveHour: null, sevenDay: null });
	}

	removed(sessionId: SessionId): void {
		this.lastReports.delete(sessionId);
	}

	// The first report of a Claude Code from before the hub started dates from the session's last activity, its last turn.
	reported(sessionId: SessionId, plan: Plan, { now, lastActiveAt }: { now: number; lastActiveAt: number }): void {
		const last = this.lastReports.get(sessionId);
		const reports: Reports = { fiveHour: plan?.fiveHour ?? null, sevenDay: plan?.sevenDay ?? null };
		for (const name of WINDOWS) {
			const window = reports[name];
			if (window === null) continue;
			if (last === undefined) this.learn(name, window, lastActiveAt);
			else if (!sameWindow(last[name], window)) this.learn(name, window, now);
		}
		this.lastReports.set(sessionId, { fiveHour: reports.fiveHour ?? last?.fiveHour ?? null, sevenDay: reports.sevenDay ?? last?.sevenDay ?? null });
	}

	// An exchange the hub had with Claude itself reports the windows as they stand.
	exchanged(plan: NonNullable<Plan>, now: number): void {
		for (const name of WINDOWS) {
			const window = plan[name];
			if (window !== null) this.learn(name, window, now);
		}
	}

	private learn(name: WindowName, window: NonNullable<PlanWindow>, seenAt: number): void {
		const kept = this.known[name];
		if (kept === null || kept.seenAt <= seenAt) this.known = { ...this.known, [name]: { window, seenAt } };
	}
}
