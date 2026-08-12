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
  type HttpTransport,
  object,
  optionalString,
  responseJson,
  string,
} from "./tracker-http.ts";

export interface LinearAdapterOptions {
  token: string;
  endpoint?: string;
  transport?: HttpTransport;
  pageSize?: number;
}

export class LinearTrackerAdapter
  extends AssignmentTrackerAdapter
  implements FrontierTrackerAdapter
{
  readonly #token: string;
  readonly #endpoint: string;
  readonly #transport: HttpTransport;
  readonly #pageSize: number;

  constructor(options: LinearAdapterOptions) {
    super();
    if (!options.token) throw new Error("Linear token is required");
    if (
      options.pageSize !== undefined &&
      (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 50)
    ) {
      throw new Error("Linear page size must be an integer from 1 to 50");
    }
    this.#token = options.token;
    this.#endpoint = options.endpoint ?? "https://api.linear.app/graphql";
    this.#transport = options.transport ?? fetchTransport;
    this.#pageSize = options.pageSize ?? 50;
  }

  async describe(): Promise<CapabilitySet> {
    return capabilities("native_maps", "native_dependencies");
  }

  async preflight(ticket: TicketRef): Promise<void> {
    await this.getTicket(ticket);
  }

  async getTicket(ticket: TicketRef): Promise<Ticket> {
    const parsed = linearRef(ticket, "ticket");
    const data = await this.#graphql(ISSUE_QUERY, {
      id: parsed.nativeId,
      nestedFirst: this.#pageSize,
    });
    const issue = object(data.issue, "Linear issue");
    await this.#completeNestedConnections(issue);
    return normalizeLinearTicket(issue, ticket, 0);
  }

  async listMapTickets(map: MapRef): Promise<Ticket[]> {
    const parsed = linearRef(map, "map");
    const nodes: Record<string, unknown>[] = [];
    let after: string | null = null;
    do {
      const data = await this.#graphql(MAP_TICKETS_QUERY, {
        id: parsed.nativeId,
        first: this.#pageSize,
        after,
        nestedFirst: this.#pageSize,
      });
      const children = object(object(data.issue, "Linear map").children, "Linear children");
      const page = children.nodes;
      if (!Array.isArray(page)) throw new Error("Invalid Linear children page");
      for (const item of page) {
        const node = object(item, "Linear child");
        await this.#completeNestedConnections(node);
        nodes.push(node);
      }
      const pageInfo = object(children.pageInfo, "Linear page info");
      after = pageInfo.hasNextPage === true ? string(pageInfo.endCursor, "Linear cursor") : null;
    } while (after !== null);

    return nodes.map((node, order) =>
      normalizeLinearTicket(
        node,
        `${parsed.adapter}:${parsed.instance}:${parsed.workspace}:ticket:${string(node.id, "issue id")}` as TicketRef,
        order,
      ),
    );
  }

  async readAssignment(ticket: TicketRef): Promise<AssignmentState> {
    const parsed = linearRef(ticket, "ticket");
    const data = await this.#graphql(ASSIGNMENT_QUERY, { id: parsed.nativeId });
    const issue = object(data.issue, "Linear issue assignment");
    const assignee =
      issue.assignee === null
        ? undefined
        : (string(object(issue.assignee, "Linear assignee").id, "assignee id") as ActorRef);
    return {
      version: string(issue.updatedAt, "issue updatedAt"),
      ...(assignee ? { assignee } : {}),
    };
  }

  async writeAssignment(ticket: TicketRef, assignee?: ActorRef): Promise<void> {
    const parsed = linearRef(ticket, "ticket");
    const data = await this.#graphql(ASSIGN_MUTATION, {
      id: parsed.nativeId,
      input: { assigneeId: assignee ?? null },
    });
    if (object(data.issueUpdate, "Linear issueUpdate").success !== true) {
      throw new Error("Linear assignment update did not report success");
    }
  }

  async #completeNestedConnections(issue: Record<string, unknown>): Promise<void> {
    const issueId = string(issue.id, "Linear issue id");
    await this.#completeConnection(issue, issueId, "labels", LABELS_PAGE_QUERY);
    await this.#completeConnection(
      issue,
      issueId,
      "inverseRelations",
      INVERSE_RELATIONS_PAGE_QUERY,
    );
  }

  async #completeConnection(
    issue: Record<string, unknown>,
    issueId: string,
    field: "labels" | "inverseRelations",
    query: string,
  ): Promise<void> {
    const connection = connectionValue(issue[field], `Linear ${field}`);
    const seenCursors = new Set<string>();
    while (connection.pageInfo.hasNextPage === true) {
      const after = string(connection.pageInfo.endCursor, `Linear ${field} cursor`);
      if (seenCursors.has(after)) throw new Error(`Linear ${field} pagination cursor repeated`);
      seenCursors.add(after);
      const data = await this.#graphql(query, {
        id: issueId,
        first: this.#pageSize,
        after,
      });
      const page = connectionValue(
        object(data.issue, "Linear nested issue")[field],
        `Linear ${field}`,
      );
      connection.nodes.push(...page.nodes);
      connection.pageInfo = page.pageInfo;
    }
    issue[field] = connection;
  }

  async #graphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.#transport(this.#endpoint, {
      method: "POST",
      headers: { Authorization: this.#token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const envelope = object(
      await responseJson(response, "Linear GraphQL request"),
      "Linear GraphQL",
    );
    if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
      const messages = envelope.errors.map(
        (error) => optionalString(object(error, "Linear error").message) ?? "unknown error",
      );
      throw new Error(`Linear GraphQL errors: ${messages.join("; ")}`);
    }
    return object(envelope.data, "Linear GraphQL data");
  }
}

function normalizeLinearTicket(
  node: Record<string, unknown>,
  ref: TicketRef,
  order: number,
): Ticket {
  const parent =
    node.parent === null || node.parent === undefined
      ? undefined
      : object(node.parent, "Linear parent");
  const mapId = parent ? string(parent.id, "parent id") : string(node.id, "issue id");
  const parsed = linearRef(ref, "ticket");
  const labelConnection = connectionValue(node.labels, "Linear labels");
  const labels = labelConnection.nodes;
  const labelNames = Array.isArray(labels)
    ? labels.map((label) => string(object(label, "Linear label").name, "label name"))
    : [];
  const kind = kindFromLabels(labelNames);
  const relations = connectionValue(node.inverseRelations, "Linear inverse relations").nodes;
  const dependencies = Array.isArray(relations)
    ? relations.flatMap((relation) => {
        const item = object(relation, "Linear relation");
        if (item.type !== "blocks") return [];
        const blocker = object(item.issue, "Linear blocking issue");
        return [
          {
            blocking:
              `${parsed.adapter}:${parsed.instance}:${parsed.workspace}:ticket:${string(blocker.id, "blocking issue id")}` as TicketRef,
            blocked: ref,
            kind: "blocks" as const,
          },
        ];
      })
    : [];
  const assignee =
    node.assignee === null || node.assignee === undefined
      ? undefined
      : (string(object(node.assignee, "Linear assignee").id, "assignee id") as ActorRef);
  const state = object(node.state, "Linear state");
  return {
    ref,
    map: `${parsed.adapter}:${parsed.instance}:${parsed.workspace}:map:${mapId}` as MapRef,
    kind,
    state: node.canceledAt || node.completedAt ? "closed" : "open",
    status: string(state.name, "state name"),
    ...(assignee ? { assignee } : {}),
    dependencies,
    order,
    metadata: {
      identifier: string(node.identifier, "issue identifier"),
      version: string(node.updatedAt, "issue updatedAt"),
      versionSource: "linear.updatedAt",
    },
  };
}

function connectionValue(
  value: unknown,
  context: string,
): { nodes: unknown[]; pageInfo: Record<string, unknown> } {
  const connection = object(value, context);
  if (!Array.isArray(connection.nodes)) throw new Error(`Invalid ${context} nodes`);
  const pageInfo = object(connection.pageInfo, `${context} page info`);
  return { nodes: connection.nodes, pageInfo };
}

function kindFromLabels(labels: string[]): TicketKind {
  const matches = labels
    .map((label) =>
      /^wayfinder:(task|research|prototype|decision)$/i.exec(label)?.[1]?.toLowerCase(),
    )
    .filter((value): value is TicketKind => value !== undefined);
  const kind = matches[0];
  if (matches.length !== 1 || kind === undefined) {
    throw new Error("Linear issue must have exactly one Wayfinder type label");
  }
  return kind;
}

function linearRef(ref: string, kind: "map" | "ticket") {
  const parsed = parseRef(ref);
  if (
    parsed.adapter !== "linear" ||
    parsed.kind !== kind ||
    !parsed.nativeId ||
    !parsed.instance ||
    !parsed.workspace
  ) {
    throw new Error(`Expected a qualified Linear ${kind} reference`);
  }
  return {
    ...parsed,
    adapter: "linear",
    nativeId: parsed.nativeId,
    instance: parsed.instance,
    workspace: parsed.workspace,
  };
}

const ISSUE_FIELDS = `id identifier updatedAt completedAt canceledAt parent { id } assignee { id } state { name } labels(first: $nestedFirst) { nodes { name } pageInfo { hasNextPage endCursor } } inverseRelations(first: $nestedFirst) { nodes { type issue { id completedAt canceledAt } } pageInfo { hasNextPage endCursor } }`;
const ISSUE_QUERY = `query Issue($id: String!, $nestedFirst: Int!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;
const ASSIGNMENT_QUERY = `query Assignment($id: String!) { issue(id: $id) { updatedAt assignee { id } } }`;
const ASSIGN_MUTATION = `mutation Assign($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;
const MAP_TICKETS_QUERY = `query MapTickets($id: String!, $first: Int!, $after: String, $nestedFirst: Int!) { issue(id: $id) { children(first: $first, after: $after) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } } }`;
const LABELS_PAGE_QUERY = `query IssueLabels($id: String!, $first: Int!, $after: String!) { issue(id: $id) { labels(first: $first, after: $after) { nodes { name } pageInfo { hasNextPage endCursor } } } }`;
const INVERSE_RELATIONS_PAGE_QUERY = `query IssueInverseRelations($id: String!, $first: Int!, $after: String!) { issue(id: $id) { inverseRelations(first: $first, after: $after) { nodes { type issue { id completedAt canceledAt } } pageInfo { hasNextPage endCursor } } } }`;
