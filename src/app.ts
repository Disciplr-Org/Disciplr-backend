import express, { type Request, type Response } from "express";
import helmet from "helmet";
import cors from "cors";
import { v1Router } from "./routes/v1.js";
import { apiVersionHeader } from "./middleware/apiVersion.js";
import { privacyLogger } from "./middleware/privacy-logger.js";

export const app = express();

app.use(helmet());

// CORS: Origin validation
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [
  "http://localhost:3000",
];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(privacyLogger);

// Versioned API routes
app.use("/api/v1", apiVersionHeader("v1"), v1Router);

// Backward-compat: redirect unversioned /api/* → /api/v1/*
app.use("/api", (req: Request, res: Response) => {
  res.redirect(307, `/api/v1${req.path}`);
});
