import type { FrontierTrackerAdapter } from "./contracts.ts";
import {
  type ActorRef,
  type CapabilitySet,
  capabilities,
  type MapRef,
  type Ticket,
  type TicketKind,
  type TicketRef,
} from "./domain.ts";
import { parseRef } from "./reference.ts";
import { type AssignmentState, AssignmentTrackerAdapter } from "./tracker-common.ts";
import {
  fetchTransport,
  type HttpResponse,
  type HttpTransport,
  object,
  responseJson,
  string,
} from "./tracker-http.ts";

export interface GitHubAdapterOptions {
  token: string;
  apiBase?: string;
  transport?: HttpTransport;
  pageSize?: number;
}

export class GitHubIssuesTrackerAdapter
  extends AssignmentTrackerAdapter
  implements FrontierTrackerAdapter
{
  readonly #token: string;
  readonly #apiBase: string;
  readonly #transport: HttpTransport;
  readonly #pageSize: number;

  constructor(options: GitHubAdapterOptions) {
    super();
    if (!options.token) throw new Error("GitHub token is required");
    this.#token = options.token;
    this.#apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    this.#transport = options.transport ?? fetchTransport;
    this.#pageSize = options.pageSize ?? 100;
  }

  async describe(): Promise<CapabilitySet> {
    return capabilities("native_maps", "native_dependencies");
  }

  async preflight(ticket: TicketRef): Promise<void> {
    await this.getTicket(ticket);
  }

  async getTicket(ticket: TicketRef): Promise<Ticket> {
    const parsed = githubRef(ticket, "ticket");
    const issue = object(await this.#get(this.#issueUrl(parsed)), "GitHub issue");
    return this.#normalize(issue, ticket, ticketMapRef(parsed, parsed.nativeId), 0, []);
  }

  async listMapTickets(map: MapRef): Promise<Ticket[]> {
    const parsed = githubRef(map, "map");
    const children = await this.#paginate(`${this.#issueUrl(parsed)}/sub_issues`);
    const normalized: Ticket[] = [];
    for (const [order, child] of children.entries()) {
      if (child.pull_request !== undefined) continue;
      const number = String(child.number);
      const ref = ticketRef(parsed, number);
      const blockers = await this.#paginate(
        `${this.#issueUrl({ ...parsed, nativeId: number })}/dependencies/blocked_by`,
      );
      normalized.push(this.#normalize(child, ref, map, order, blockers));
    }
    return normalized;
  }

  async readAssignment(ticket: TicketRef): Promise<AssignmentState> {
    const parsed = githubRef(ticket, "ticket");
    const response = await this.#request(this.#issueUrl(parsed));
    const issue = object(await responseJson(response, "GitHub issue read"), "GitHub issue");
    const assignees = issue.assignees;
    if (!Array.isArray(assignees)) throw new Error("Invalid GitHub assignees");
    if (assignees.length > 1)
      throw new Error("GitHub issue has multiple assignees and is not claimable");
    const assignee = assignees[0]
      ? (string(object(assignees[0], "GitHub assignee").login, "assignee login") as ActorRef)
      : undefined;
    const version = response.headers.get("etag") ?? string(issue.updated_at, "issue updated_at");
    return { version, ...(assignee ? { assignee } : {}) };
  }

  async writeAssignment(ticket: TicketRef, assignee?: ActorRef): Promise<void> {
    const parsed = githubRef(ticket, "ticket");
    await this.#request(this.#issueUrl(parsed), "PATCH", { assignees: assignee ? [assignee] : [] });
  }

  #normalize(
    issue: Record<string, unknown>,
    ref: TicketRef,
    map: MapRef,
    order: number,
    blockers: Record<string, unknown>[],
  ): Ticket {
    if (issue.pull_request !== undefined)
      throw new Error("GitHub pull requests are not Wayfinder tickets");
    const labels = issue.labels;
    if (!Array.isArray(labels)) throw new Error("Invalid GitHub issue labels");
    const kind = kindFromLabels(
      labels.map((label) =>
        typeof label === "string"
          ? label
          : string(object(label, "GitHub label").name, "label name"),
      ),
    );
    const assignees = issue.assignees;
    if (!Array.isArray(assignees)) throw new Error("Invalid GitHub issue assignees");
    const assignee = assignees[0]
      ? (string(object(assignees[0], "GitHub assignee").login, "assignee login") as ActorRef)
      : undefined;
    const parsed = githubRef(ref, "ticket");
    return {
      ref,
      map,
      kind,
      state: issue.state === "closed" ? "closed" : "open",
      status: string(issue.state, "issue state"),
      ...(assignee ? { assignee } : {}),
      dependencies: blockers.map((blocker) => ({
        blocking: ticketRef(parsed, String(blocker.number)),
        blocked: ref,
        kind: "blocks",
      })),
      order,
      metadata: {
        number: issue.number,
        updatedAt: string(issue.updated_at, "issue updated_at"),
        url: string(issue.html_url, "issue html_url"),
      },
    };
  }

  async #paginate(url: string): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [];
    let next: string | undefined =
      `${url}${url.includes("?") ? "&" : "?"}per_page=${this.#pageSize}`;
    while (next) {
      const response = await this.#request(next);
      const page = await responseJson(response, "GitHub paginated read");
      if (!Array.isArray(page)) throw new Error("Invalid GitHub paginated response");
      result.push(...page.map((item) => object(item, "GitHub page item")));
      next = nextLink(response.headers.get("link"));
    }
    return result;
  }

  async #get(url: string): Promise<unknown> {
    const response = await this.#request(url);
    return responseJson(response, "GitHub request");
  }

  async #request(url: string, method = "GET", body?: unknown): Promise<HttpResponse> {
    const response = await this.#transport(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.#token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status < 200 || response.status >= 300) {
      await responseJson(response, `GitHub ${method}`);
    }
    return response;
  }

  #issueUrl(ref: ReturnType<typeof githubRef>): string {
    const [owner, repository, extra] = ref.workspace.split("/");
    if (!owner || !repository || extra)
      throw new Error("GitHub workspace must be owner/repository");
    return `${this.#apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${encodeURIComponent(ref.nativeId)}`;
  }
}

function nextLink(value: string | null): string | undefined {
  if (!value) return undefined;
  for (const part of value.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"/.exec(part);
    if (match?.[2] === "next") return match[1];
  }
  return undefined;
}

function kindFromLabels(labels: string[]): TicketKind {
  const matches = labels
    .map((label) =>
      /^wayfinder:(task|research|prototype|decision)$/i.exec(label)?.[1]?.toLowerCase(),
    )
    .filter((value): value is TicketKind => value !== undefined);
  const kind = matches[0];
  if (matches.length !== 1 || kind === undefined) {
    throw new Error("GitHub issue must have exactly one Wayfinder type label");
  }
  return kind;
}

function githubRef(ref: string, kind: "map" | "ticket") {
  const parsed = parseRef(ref);
  if (
    parsed.adapter !== "github" ||
    parsed.kind !== kind ||
    !parsed.nativeId ||
    !parsed.instance ||
    !parsed.workspace
  ) {
    throw new Error(`Expected a qualified GitHub ${kind} reference`);
  }
  return {
    ...parsed,
    adapter: "github",
    nativeId: parsed.nativeId,
    instance: parsed.instance,
    workspace: parsed.workspace,
  };
}

function ticketRef(ref: ReturnType<typeof githubRef>, number: string): TicketRef {
  return `github:${ref.instance}:${ref.workspace}:ticket:${number}` as TicketRef;
}

function ticketMapRef(ref: ReturnType<typeof githubRef>, number: string): MapRef {
  return `github:${ref.instance}:${ref.workspace}:map:${number}` as MapRef;
}
