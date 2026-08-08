import { expressjwt } from "express-jwt";
import { JwtPayload } from "jsonwebtoken";
import { Config } from "../config";
import { Request } from "express";
import { AuthCookie, IRefreshTokenPayload } from "../types";
import { AppDataSource } from "../config/data-source";
import { RefreshToken } from "../entity/RefreshToken";
import logger from "../config/logger";

export default expressjwt({
    secret: Config.REFRESH_TOKEN_SECRET!,
    algorithms: ["HS256"],
    getToken(req: Request) {
        const { refreshToken } = req.cookies as AuthCookie;
        return refreshToken;
    },
    async isRevoked(request: Request, token) {
        // express-jwt types `payload` as `JwtPayload | string`. Reading `.sub`
        // off the un-narrowed union resolved to String.prototype.sub, so
        // Number(...) yielded NaN and the user lookup could never match.
        const payload = token?.payload as IRefreshTokenPayload & JwtPayload;

        try {
            const refreshTokenRepo = AppDataSource.getRepository(RefreshToken);
            const refreshToken = await refreshTokenRepo.findOne({
                where: {
                    id: Number(payload.id),
                    user: { id: Number(payload.sub) },
                },
            });
            return refreshToken === null;
        } catch {
            logger.error("Error while getting the refresh token", {
                id: payload.id,
            });
        }
        return true;
    },
});
