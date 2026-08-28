import { Hono } from "hono";
import { corsMiddleware } from "@/middleware/cors";
import { errorHandler } from "@/middleware/error-handler";
import { attachUser } from "@/middleware/auth";
import { health } from "@/routes/health";
import { products } from "@/routes/products";
import { search } from "@/routes/search";
import { auth } from "@/routes/auth";
import { ordersRoute } from "@/routes/orders";
import { wishlist } from "@/routes/wishlist";
import { uploads } from "@/routes/uploads";
import { isbn } from "@/routes/isbn";
import { images } from "@/routes/images";
import type { Env, Variables } from "@/types/env";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.onError(errorHandler);
app.use("*", corsMiddleware());
app.use("*", attachUser);

app.route("/api/health", health);
app.route("/api/products", products);
app.route("/api/search", search);
app.route("/api/auth", auth);
app.route("/api/orders", ordersRoute);
app.route("/api/wishlist", wishlist);
app.route("/api/uploads", uploads);
app.route("/api/isbn", isbn);
app.route("/api/images", images);

export default app;
