import { DataSource, Repository } from "typeorm";
import bcrypt from "bcryptjs";
import { sign } from "jsonwebtoken";
import { Response } from "supertest";
import { Tenant } from "../../src/entity/Tenant";
import { User } from "../../src/entity/User";
import { RefreshToken } from "../../src/entity/RefreshToken";
import { Config } from "../../src/config";
import { Roles } from "../../src/constants";

export const truncateTables = async (connection: DataSource) => {
    const entities = connection.entityMetadatas;
    for (const entity of entities) {
        const repository = connection.getRepository(entity.name);
        await repository.clear();
    }
};

export const isJwt = (token: string | null): boolean => {
    if (token === null) {
        return false;
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
        return false;
    }

    try {
        parts.forEach((part) => {
            Buffer.from(part, "base64").toString("utf-8");
        });
        return true;
    } catch (err) {
        return false;
    }
};

export const createTenant = async (repository: Repository<Tenant>) => {
    const tenant = await repository.save({
        name: "Test tenant",
        address: "Test address",
    });
    return tenant;
};

/**
 * Persists a user with a bcrypt-hashed password, the way the register/login
 * flow would leave it. Overrides let a test vary one field without restating
 * the rest.
 */
export const createUser = async (
    repository: Repository<User>,
    overrides: Partial<User> & { password?: string } = {},
) => {
    const { password = "password", ...rest } = overrides;
    return await repository.save({
        firstName: "Rakesh",
        lastName: "K",
        email: "rakesh@mern.space",
        role: Roles.CUSTOMER,
        tenant: null,
        ...rest,
        password: await bcrypt.hash(password, 10),
    });
};

/**
 * Pulls the auth cookies out of a supertest response. Every existing spec
 * open-codes this loop; new specs use the helper instead.
 */
export const extractAuthCookies = (response: Response) => {
    interface Headers {
        ["set-cookie"]: string[];
    }
    const cookies =
        (response.headers as unknown as Headers)["set-cookie"] || [];

    let accessToken: string | null = null;
    let refreshToken: string | null = null;

    cookies.forEach((cookie) => {
        if (cookie.startsWith("accessToken=")) {
            accessToken = cookie.split(";")[0].split("=")[1];
        }
        if (cookie.startsWith("refreshToken=")) {
            refreshToken = cookie.split(";")[0].split("=")[1];
        }
    });

    return {
        accessToken: accessToken as string | null,
        refreshToken: refreshToken as string | null,
        raw: cookies,
    };
};

/**
 * Persists a refreshTokens row for the user and signs the matching HS256
 * token. Both halves are required: `validateRefreshToken` looks the row up by
 * (token id, user id) and treats a missing row as revoked, so a token signed
 * without a row is rejected — which is exactly the revocation mechanism.
 */
export const createRefreshToken = async (
    repository: Repository<RefreshToken>,
    user: User,
) => {
    const MS_IN_YEAR = 1000 * 60 * 60 * 24 * 365;
    const row = await repository.save({
        user,
        expiresAt: new Date(Date.now() + MS_IN_YEAR),
    });

    const token = sign(
        {
            sub: String(user.id),
            role: user.role,
            tenant: user.tenant ? String(user.tenant.id) : "",
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            id: String(row.id),
        },
        Config.REFRESH_TOKEN_SECRET!,
        {
            algorithm: "HS256",
            expiresIn: "1y",
            issuer: "auth-service",
            jwtid: String(row.id),
        },
    );

    return { row, token };
};
