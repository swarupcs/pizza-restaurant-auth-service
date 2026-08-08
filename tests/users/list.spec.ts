import { DataSource } from "typeorm";
import bcrypt from "bcryptjs";
import request from "supertest";
import createJWKSMock from "mock-jwks";

import { AppDataSource } from "../../src/config/data-source";
import app from "../../src/app";
import { Roles } from "../../src/constants";
import { User } from "../../src/entity/User";
import { Tenant } from "../../src/entity/Tenant";
import { createTenant, createUser } from "../utils";

interface UserListResponse {
    currentPage: number;
    perPage: number;
    total: number;
    data: User[];
}

describe("GET /users", () => {
    let connection: DataSource;
    let jwks: ReturnType<typeof createJWKSMock>;
    let adminToken: string;

    beforeAll(async () => {
        jwks = createJWKSMock("http://localhost:5501");
        connection = await AppDataSource.initialize();
    });

    beforeEach(async () => {
        jwks.start();
        await connection.dropDatabase();
        await connection.synchronize();

        adminToken = jwks.token({ sub: "1", role: Roles.ADMIN });
    });

    afterEach(() => {
        jwks.stop();
    });

    afterAll(async () => {
        await connection.destroy();
    });

    /**
     * Seeds `count` customers with distinct names and emails, in a single
     * save so the test database is hit once rather than `count` times.
     */
    const seedUsers = async (count: number) => {
        const userRepository = connection.getRepository(User);
        const hashedPassword = await bcrypt.hash("password", 10);
        return await userRepository.save(
            Array.from({ length: count }, (_, i) => ({
                firstName: `User${i}`,
                lastName: "Test",
                email: `user${i}@mern.space`,
                password: hashedPassword,
                role: Roles.CUSTOMER,
                tenant: null,
            })),
        );
    };

    describe("Pagination", () => {
        it("should return the 200 status code", async () => {
            const response = await request(app)
                .get("/users")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            expect(response.statusCode).toBe(200);
        });

        it("should return a paginated envelope", async () => {
            await seedUsers(3);

            const response = await request(app)
                .get("/users")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const body = response.body as UserListResponse;

            expect(body).toHaveProperty("currentPage");
            expect(body).toHaveProperty("perPage");
            expect(body).toHaveProperty("total");
            expect(body).toHaveProperty("data");
            expect(body.total).toBe(3);
            expect(body.data).toHaveLength(3);
        });

        it("should default to page 1 with 6 records per page", async () => {
            await seedUsers(8);

            const response = await request(app)
                .get("/users")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const body = response.body as UserListResponse;

            expect(body.currentPage).toBe(1);
            expect(body.perPage).toBe(6);
            expect(body.total).toBe(8);
            expect(body.data).toHaveLength(6);
        });

        it("should return the remaining records on the next page", async () => {
            await seedUsers(8);

            const response = await request(app)
                .get("/users")
                .query({ currentPage: 2 })
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const body = response.body as UserListResponse;

            expect(body.currentPage).toBe(2);
            expect(body.total).toBe(8);
            expect(body.data).toHaveLength(2);
        });

        it("should respect an explicit perPage", async () => {
            await seedUsers(5);

            const response = await request(app)
                .get("/users")
                .query({ perPage: 2 })
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const body = response.body as UserListResponse;

            expect(body.perPage).toBe(2);
            expect(body.data).toHaveLength(2);
        });

        it("should fall back to the defaults when the page params are not numbers", async () => {
            await seedUsers(8);

            const response = await request(app)
                .get("/users")
                .query({ currentPage: "abc", perPage: "xyz" })
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const body = response.body as UserListResponse;

            expect(body.currentPage).toBe(1);
            expect(body.perPage).toBe(6);
            expect(body.data).toHaveLength(6);
        });

        it("should return the newest users first", async () => {
            const users = await seedUsers(3);

            const response = await request(app)
                .get("/users")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const body = response.body as UserListResponse;
            const returnedIds = body.data.map((user) => user.id);

            expect(returnedIds).toEqual(users.map((user) => user.id).reverse());
        });

        it("should return an empty list when there are no users", async () => {
            const response = await request(app)
                .get("/users")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const body = response.body as UserListResponse;

            expect(body.total).toBe(0);
            expect(body.data).toHaveLength(0);
        });
    });

    describe("Filtering and searching", () => {
        it("should filter by role", async () => {
            const userRepository = connection.getRepository(User);
            await createUser(userRepository, {
                email: "customer@mern.space",
                role: Roles.CUSTOMER,
            });
            await createUser(userRepository, {
                email: "manager@mern.space",
                role: Roles.MANAGER,
            });

            const response = await request(app)
                .get("/users")
                .query({ role: Roles.MANAGER })
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const body = response.body as UserListResponse;

            expect(body.total).toBe(1);
            expect(body.data[0].email).toBe("manager@mern.space");
        });

        it("should search on the full name", async () => {
            const userRepository = connection.getRepository(User);
            await createUser(userRepository, {
                firstName: "Rakesh",
                lastName: "Kumar",
                email: "rakesh@mern.space",
            });
            await createUser(userRepository, {
                firstName: "Swarup",
                lastName: "Das",
                email: "swarup@mern.space",
            });

            const response = await request(app)
                .get("/users")
                .query({ q: "Swarup Das" })
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const body = response.body as UserListResponse;

            expect(body.total).toBe(1);
            expect(body.data[0].email).toBe("swarup@mern.space");
        });

        it("should search on the email, case-insensitively", async () => {
            const userRepository = connection.getRepository(User);
            await createUser(userRepository, { email: "rakesh@mern.space" });
            await createUser(userRepository, { email: "swarup@mern.space" });

            const response = await request(app)
                .get("/users")
                .query({ q: "SWARUP@MERN" })
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const body = response.body as UserListResponse;

            expect(body.total).toBe(1);
            expect(body.data[0].email).toBe("swarup@mern.space");
        });

        it("should combine the search term and the role filter", async () => {
            const userRepository = connection.getRepository(User);
            await createUser(userRepository, {
                firstName: "Swarup",
                lastName: "Das",
                email: "swarup.customer@mern.space",
                role: Roles.CUSTOMER,
            });
            await createUser(userRepository, {
                firstName: "Swarup",
                lastName: "Das",
                email: "swarup.manager@mern.space",
                role: Roles.MANAGER,
            });

            const response = await request(app)
                .get("/users")
                .query({ q: "Swarup", role: Roles.MANAGER })
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const body = response.body as UserListResponse;

            expect(body.total).toBe(1);
            expect(body.data[0].email).toBe("swarup.manager@mern.space");
        });
    });

    describe("Response shape", () => {
        it("should not leak the password field", async () => {
            await seedUsers(1);

            const response = await request(app)
                .get("/users")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const body = response.body as UserListResponse;

            expect(body.data[0]).not.toHaveProperty("password");
        });

        it("should include the tenant of each user", async () => {
            const tenant = await createTenant(connection.getRepository(Tenant));
            await createUser(connection.getRepository(User), {
                email: "manager@mern.space",
                role: Roles.MANAGER,
                tenant,
            });

            const response = await request(app)
                .get("/users")
                .set("Cookie", [`accessToken=${adminToken}`])
                .send();

            const body = response.body as UserListResponse;

            expect(body.data[0].tenant?.id).toBe(tenant.id);
            expect(body.data[0].tenant?.name).toBe("Test tenant");
        });
    });

    describe("Access control", () => {
        it("should return 401 if the user is not authenticated", async () => {
            const response = await request(app).get("/users").send();

            expect(response.statusCode).toBe(401);
        });

        it("should return 403 if the user is not an admin", async () => {
            const managerToken = jwks.token({
                sub: "1",
                role: Roles.MANAGER,
            });

            const response = await request(app)
                .get("/users")
                .set("Cookie", [`accessToken=${managerToken}`])
                .send();

            expect(response.statusCode).toBe(403);
        });
    });
});
