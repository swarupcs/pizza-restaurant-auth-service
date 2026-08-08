import { DataSource } from "typeorm";
import request from "supertest";

import { AppDataSource } from "../../src/config/data-source";
import app from "../../src/app";
import { Tenant } from "../../src/entity/Tenant";

interface TenantListResponse {
    currentPage: number;
    perPage: number;
    total: number;
    data: Tenant[];
}

describe("GET /tenants", () => {
    let connection: DataSource;

    beforeAll(async () => {
        connection = await AppDataSource.initialize();
    });

    beforeEach(async () => {
        await connection.dropDatabase();
        await connection.synchronize();
    });

    afterAll(async () => {
        await connection.destroy();
    });

    /**
     * Seeds `count` tenants with distinct names and addresses, in a single
     * save so the test database is hit once rather than `count` times.
     */
    const seedTenants = async (count: number) => {
        const tenantRepository = connection.getRepository(Tenant);
        return await tenantRepository.save(
            Array.from({ length: count }, (_, i) => ({
                name: `Tenant ${i}`,
                address: `Address ${i}`,
            })),
        );
    };

    describe("Pagination", () => {
        it("should return the 200 status code", async () => {
            const response = await request(app).get("/tenants").send();

            expect(response.statusCode).toBe(200);
        });

        it("should return a paginated envelope", async () => {
            await seedTenants(3);

            const response = await request(app).get("/tenants").send();
            const body = response.body as TenantListResponse;

            expect(body).toHaveProperty("currentPage");
            expect(body).toHaveProperty("perPage");
            expect(body).toHaveProperty("total");
            expect(body).toHaveProperty("data");
            expect(body.total).toBe(3);
            expect(body.data).toHaveLength(3);
        });

        it("should default to page 1 with 6 records per page", async () => {
            await seedTenants(8);

            const response = await request(app).get("/tenants").send();
            const body = response.body as TenantListResponse;

            expect(body.currentPage).toBe(1);
            expect(body.perPage).toBe(6);
            expect(body.total).toBe(8);
            expect(body.data).toHaveLength(6);
        });

        it("should return the remaining records on the next page", async () => {
            await seedTenants(8);

            const response = await request(app)
                .get("/tenants")
                .query({ currentPage: 2 })
                .send();
            const body = response.body as TenantListResponse;

            expect(body.currentPage).toBe(2);
            expect(body.data).toHaveLength(2);
        });

        it("should respect an explicit perPage", async () => {
            await seedTenants(5);

            const response = await request(app)
                .get("/tenants")
                .query({ perPage: 2 })
                .send();
            const body = response.body as TenantListResponse;

            expect(body.perPage).toBe(2);
            expect(body.data).toHaveLength(2);
        });

        it("should return the newest tenants first", async () => {
            const tenants = await seedTenants(3);

            const response = await request(app).get("/tenants").send();
            const body = response.body as TenantListResponse;

            expect(body.data.map((tenant) => tenant.id)).toEqual(
                tenants.map((tenant) => tenant.id).reverse(),
            );
        });

        it("should return an empty list when there are no tenants", async () => {
            const response = await request(app).get("/tenants").send();
            const body = response.body as TenantListResponse;

            expect(body.total).toBe(0);
            expect(body.data).toHaveLength(0);
        });
    });

    describe("Searching", () => {
        it("should search on the name", async () => {
            const tenantRepository = connection.getRepository(Tenant);
            await tenantRepository.save({
                name: "Pizza Palace",
                address: "MG Road",
            });
            await tenantRepository.save({
                name: "Burger Barn",
                address: "Park Street",
            });

            const response = await request(app)
                .get("/tenants")
                .query({ q: "Pizza" })
                .send();
            const body = response.body as TenantListResponse;

            expect(body.total).toBe(1);
            expect(body.data[0].name).toBe("Pizza Palace");
        });

        it("should search on the address, case-insensitively", async () => {
            const tenantRepository = connection.getRepository(Tenant);
            await tenantRepository.save({
                name: "Pizza Palace",
                address: "MG Road",
            });
            await tenantRepository.save({
                name: "Burger Barn",
                address: "Park Street",
            });

            const response = await request(app)
                .get("/tenants")
                .query({ q: "park street" })
                .send();
            const body = response.body as TenantListResponse;

            expect(body.total).toBe(1);
            expect(body.data[0].name).toBe("Burger Barn");
        });
    });

    describe("Access control", () => {
        it("should be reachable without authentication", async () => {
            // Deliberate assertion of current behaviour: unlike every other
            // /tenants route, this one has no `authenticate` middleware, so
            // the full tenant list — names and addresses — is public. The
            // admin UI relies on it during the create-user flow. Flagged
            // rather than silently changed; if it is ever locked down, this
            // test is the one that should be updated first.
            const response = await request(app).get("/tenants").send();

            expect(response.statusCode).toBe(200);
        });
    });
});
