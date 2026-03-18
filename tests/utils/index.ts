import { DataSource, Repository } from "typeorm";
import { Tenant } from "../../src/entity/Tenant";

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
