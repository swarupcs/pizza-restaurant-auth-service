import "reflect-metadata";

import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import authRouter from "./routes/auth";
import tenantRouter from "./routes/tenant";
import userRouter from "./routes/user";
import { globalErrorHandler } from "./middlewares/globalErrorHandler";

const app = express();
app.use(
    cors({
        // todo: move to .env file.
        origin: ["http://localhost:5174", "http://localhost:5173"],
        credentials: true,
    }),
);
app.use(express.static("public"));
app.use(cookieParser());
app.use(express.json());

app.get("/", (req, res) => {
    res.send("Welcome to Auth service");
});

app.use("/auth", authRouter);
app.use("/tenants", tenantRouter);
app.use("/users", userRouter);

app.use(globalErrorHandler);

export default app;
