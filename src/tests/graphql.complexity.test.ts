import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/errorHandler.js";
import {
  graphqlRouter,
  GRAPHQL_MAX_COMPLEXITY,
  GRAPHQL_MAX_DEPTH,
} from "../routes/graphql.js";

describe("GraphQL depth and complexity guards", () => {
  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/api/graphql", graphqlRouter);
    app.use(errorHandler);
    return app;
  };

  it("rejects a query that exceeds the max depth", async () => {
    const app = buildApp();

    const overDepthQuery = `
      query {
        viewer {
          stats {
            __typename {
              __typename {
                __typename
              }
            }
          }
        }
      }
    `;

    const res = await request(app)
      .post("/api/graphql")
      .send({ query: overDepthQuery });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
    expect(res.body.error.message).toContain(
      `maximum allowed depth of ${GRAPHQL_MAX_DEPTH}`,
    );
    expect(res.body.error.details).toMatchObject({
      limitType: "depth",
      maxAllowed: GRAPHQL_MAX_DEPTH,
    });
    expect(res.body.error.details.actual).toBeGreaterThan(GRAPHQL_MAX_DEPTH);
  });

  it("rejects a query that exceeds the complexity budget", async () => {
    const app = buildApp();

    const overComplexQuery = `
      query {
        first: viewer { id name stats { score rank } }
        second: viewer { id name stats { score rank } }
        metrics { uptime status }
      }
    `;

    const res = await request(app)
      .post("/api/graphql")
      .send({ query: overComplexQuery });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
    expect(res.body.error.message).toContain(
      `maximum allowed complexity of ${GRAPHQL_MAX_COMPLEXITY}`,
    );
    expect(res.body.error.details).toMatchObject({
      limitType: "complexity",
      maxAllowed: GRAPHQL_MAX_COMPLEXITY,
    });
    expect(res.body.error.details.actual).toBeGreaterThan(
      GRAPHQL_MAX_COMPLEXITY,
    );
  });

  it("accepts a normal query within the configured limits", async () => {
    const app = buildApp();

    const validQuery = `
      query {
        viewer {
          id
          name
          stats {
            score
            rank
          }
        }
        metrics {
          status
        }
      }
    `;

    const res = await request(app)
      .post("/api/graphql")
      .send({ query: validQuery });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      viewer: {
        id: "viewer-1",
        name: "Disciplr Demo",
        stats: {
          score: 42,
          rank: "gold",
        },
      },
      metrics: {
        status: "ok",
      },
    });
  });

  it("accepts a boundary-valid query at the exact complexity limit", async () => {
    const app = buildApp();

    const boundaryQuery = `
      query {
        viewer {
          id
          name
          stats {
            score
            rank
            __typename
          }
        }
        metrics {
          uptime
          status
          __typename
        }
        __typename
      }
    `;

    const res = await request(app)
      .post("/api/graphql")
      .send({ query: boundaryQuery });

    expect(res.status).toBe(200);
    expect(res.body.extensions.limits).toEqual({
      depth: GRAPHQL_MAX_DEPTH,
      complexity: GRAPHQL_MAX_COMPLEXITY,
    });
    expect(res.body.data.__typename).toBe("Query");
    expect(res.body.data.viewer.stats.__typename).toBe("ViewerStats");
    expect(res.body.data.metrics.__typename).toBe("Metrics");
  });

  it("allows lightweight introspection via __typename within limits", async () => {
    const app = buildApp();

    const introspectionQuery = `
      query {
        __typename
        viewer {
          __typename
        }
      }
    `;

    const res = await request(app)
      .post("/api/graphql")
      .send({ query: introspectionQuery });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      __typename: "Query",
      viewer: {
        __typename: "Viewer",
      },
    });
  });
});
