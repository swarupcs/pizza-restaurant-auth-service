import { DataSource } from "typeorm";
import request from "supertest";
import createJWKSMock from "mock-jwks";

import { AppDataSource } from "../../src/config/data-source";
import app from "../../src/app";
import { Tenant } from "../../src/entity/Tenant";
import { User } from "../../src/entity/User";
import { Roles } from "../../src/constants";
import { createTenant, createUser } from "../utils";

describe("DELETE /tenants/:id", () => {
    let connection: DataSource;
    let jwks: ReturnType<typeof createJWKSMock>;
    let adminToken: string;

    beforeAll(async () => {
        connection = await AppDataSource.initialize();
        jwks = createJWKSMock("http://localhost:5501");
    });

    beforeEach(async () => {
        await connection.dropDatabase();
        await connection.synchronize();
        jwks.start();

        adminToken = jwks.token({ sub: "1", role: Roles.ADMIN });
    });

    afterEach(() => {
        jwks.stop();
    });

    afterAll(async () => {
        await connection.destroy();
    });

    describe("Given an existing tenant", () => {
        it("should return the 200 status code and the deleted id", async () => {
            const tenant = await createTenant(connection.getRepository(Tenant));

            const response = await request(app)
                .delete(`/tenants/${tenant.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(response.statusCode).toBe(200);
            expect((response.body as Record<string, number>).id).toBe(
                tenant.id,
            );
        });

        it("should remove the tenant from the database", async () => {
            const tenantRepository = connection.getRepository(Tenant);
            const tenant = await createTenant(tenantRepository);

            await request(app)
                .delete(`/tenants/${tenant.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(await tenantRepository.find()).toHaveLength(0);
        });

        it("should leave other tenants alone", async () => {
            const tenantRepository = connection.getRepository(Tenant);
            const target = await createTenant(tenantRepository);
            const survivor = await tenantRepository.save({
                name: "Other tenant",
                address: "Other address",
            });

            await request(app)
                .delete(`/tenants/${target.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const remaining = await tenantRepository.find();
            expect(remaining).toHaveLength(1);
            expect(remaining[0].id).toBe(survivor.id);
        });

        it("should refuse to delete a tenant that still has users", async () => {
            // `users.tenantId` has no ON DELETE rule, so Postgres rejects the
            // delete and the error surfaces as a 500 rather than a 4xx. The
            // important guarantee is that the tenant survives — a manager
            // must never be left pointing at a tenant that no longer exists.
            const tenantRepository = connection.getRepository(Tenant);
            const tenant = await createTenant(tenantRepository);
            await createUser(connection.getRepository(User), {
                role: Roles.MANAGER,
                tenant,
            });

            const response = await request(app)
                .delete(`/tenants/${tenant.id}`)
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(response.statusCode).toBe(500);
            expect(await tenantRepository.find()).toHaveLength(1);
        });
    });

    describe("Given a bad request", () => {
        it("should return 400 if the url param is not a number", async () => {
            const response = await request(app)
                .delete("/tenants/not-a-number")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(response.statusCode).toBe(400);
        });

        it("should return 200 for an id that does not exist", async () => {
            // Same as DELETE /users/:id — the affected row count is not
            // checked, so a no-op delete still reports success.
            const response = await request(app)
                .delete("/tenants/9999")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(response.statusCode).toBe(200);
        });
    });

    describe("Access control", () => {
        it("should return 401 if the user is not authenticated", async () => {
            const tenantRepository = connection.getRepository(Tenant);
            const tenant = await createTenant(tenantRepository);

            const response = await request(app)
                .delete(`/tenants/${tenant.id}`)
                .send();

            expect(response.statusCode).toBe(401);
            expect(await tenantRepository.find()).toHaveLength(1);
        });

        it("should return 403 if the caller is not an admin", async () => {
            const tenantRepository = connection.getRepository(Tenant);
            const tenant = await createTenant(tenantRepository);
            const managerToken = jwks.token({
                sub: "1",
                role: Roles.MANAGER,
            });

            const response = await request(app)
                .delete(`/tenants/${tenant.id}`)
                .set("Cookie", [`accessToken=${managerToken}`])
                .send();

            expect(response.statusCode).toBe(403);
            expect(await tenantRepository.find()).toHaveLength(1);
        });
    });
});
