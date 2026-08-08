import { NextFunction, Request, Response } from "express";
import { HttpError } from "http-errors";

import { canAccess } from "../../src/middlewares/canAccess";
import { AuthRequest } from "../../src/types";
import { Roles } from "../../src/constants";

// Pure unit tests. `canAccess` runs after `authenticate`, so it may assume
// req.auth exists — these tests supply it directly.
describe("canAccess", () => {
    const makeRequest = (role: string) =>
        ({ auth: { role } }) as unknown as AuthRequest as Request;

    const res = {} as Response;

    it("should call next with no arguments when the role is allowed", () => {
        const next = jest.fn() as unknown as NextFunction;

        canAccess([Roles.ADMIN])(makeRequest(Roles.ADMIN), res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(next).toHaveBeenCalledWith();
    });

    it("should call next with a 403 when the role is not allowed", () => {
        const next = jest.fn() as unknown as NextFunction;

        canAccess([Roles.ADMIN])(makeRequest(Roles.MANAGER), res, next);

        expect(next).toHaveBeenCalledTimes(1);

        const error = (next as unknown as jest.Mock).mock
            .calls[0][0] as HttpError;
        expect(error.status).toBe(403);
        expect(error.message).toBe("You don't have enough permissions");
    });

    it("should allow any role in the list", () => {
        const next = jest.fn() as unknown as NextFunction;

        canAccess([Roles.ADMIN, Roles.MANAGER])(
            makeRequest(Roles.MANAGER),
            res,
            next,
        );

        expect(next).toHaveBeenCalledWith();
    });

    it("should reject a customer from an admin-only route", () => {
        const next = jest.fn() as unknown as NextFunction;

        canAccess([Roles.ADMIN])(makeRequest(Roles.CUSTOMER), res, next);

        const error = (next as unknown as jest.Mock).mock
            .calls[0][0] as HttpError;
        expect(error.status).toBe(403);
    });

    it("should reject an unknown role", () => {
        const next = jest.fn() as unknown as NextFunction;

        canAccess([Roles.ADMIN])(makeRequest("superuser"), res, next);

        const error = (next as unknown as jest.Mock).mock
            .calls[0][0] as HttpError;
        expect(error.status).toBe(403);
    });

    it("should match the role exactly, not by case", () => {
        // Roles come straight off the JWT, so a case-insensitive match would
        // be an escalation path.
        const next = jest.fn() as unknown as NextFunction;

        canAccess([Roles.ADMIN])(makeRequest("ADMIN"), res, next);

        const error = (next as unknown as jest.Mock).mock
            .calls[0][0] as HttpError;
        expect(error.status).toBe(403);
    });

    it("should reject everything when the allowed list is empty", () => {
        const next = jest.fn() as unknown as NextFunction;

        canAccess([])(makeRequest(Roles.ADMIN), res, next);

        const error = (next as unknown as jest.Mock).mock
            .calls[0][0] as HttpError;
        expect(error.status).toBe(403);
    });
});
