import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import app from "../src/app";

// No database work here — these are the routes and behaviours that live on
// the app itself rather than on a controller.
describe("app", () => {
    describe("GET /", () => {
        it("should return the 200 status code", async () => {
            const response = await request(app).get("/").send();

            expect(response.statusCode).toBe(200);
        });

        it("should return the health-check greeting", async () => {
            const response = await request(app).get("/").send();

            expect(response.text).toContain("Welcome to Auth service");
        });
    });

    describe("Unknown routes", () => {
        it("should return 404 for a path that is not mounted", async () => {
            const response = await request(app).get("/does-not-exist").send();

            expect(response.statusCode).toBe(404);
        });

        it("should return 404 for a method the route does not handle", async () => {
            // /auth/register exists, but only for POST.
            const response = await request(app).get("/auth/register").send();

            expect(response.statusCode).toBe(404);
        });
    });

    describe("Body parsing", () => {
        it("should return 400 for a malformed JSON body", async () => {
            const response = await request(app)
                .post("/auth/register")
                .set("Content-Type", "application/json")
                .send("{ not valid json");

            // express.json() rejects it before the route ever runs, and the
            // global error handler turns it into the standard envelope.
            expect(response.statusCode).toBe(400);
        });
    });

    describe("CORS", () => {
        it("should not grant access to an unlisted origin", async () => {
            const response = await request(app)
                .get("/")
                .set("Origin", "https://evil.example.com")
                .send();

            expect(response.headers["access-control-allow-origin"]).not.toBe(
                "https://evil.example.com",
            );
        });
    });

    // `public/` is gitignored — scripts/write-certs.mjs materialises it from
    // PRIVATE_KEY_BASE64 at boot. Skipped rather than silently passed where
    // the key material is absent, so a CI run reports "skipped" instead of a
    // green tick it did not earn.
    const jwksPath = path.join(__dirname, "../public/.well-known/jwks.json");
    const describeJwks = fs.existsSync(jwksPath) ? describe : describe.skip;

    describeJwks("Static files", () => {
        it("should serve the JWKS document other services validate tokens against", async () => {
            const response = await request(app)
                .get("/.well-known/jwks.json")
                .send();

            expect(response.statusCode).toBe(200);
            expect(response.body as { keys: unknown[] }).toHaveProperty("keys");
        });

        it("should expose exactly one RSA signing key", async () => {
            const response = await request(app)
                .get("/.well-known/jwks.json")
                .send();

            const body = response.body as {
                keys: { kty: string; n: string; e: string }[];
            };

            expect(body.keys).toHaveLength(1);
            expect(body.keys[0].kty).toBe("RSA");
            expect(body.keys[0]).toHaveProperty("n");
            expect(body.keys[0]).toHaveProperty("e");
        });
    });
});
