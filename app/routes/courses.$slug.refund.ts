import { data, redirect } from "react-router";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { courses } from "~/db/schema";
import { parseFormData, parseParams } from "~/lib/validation";
import {
  checkRefundRequest,
  findPurchaseToRefund,
  raiseRefundRequest,
} from "~/lib/refunds.server";
import { sendEmail } from "~/lib/mailer.server";

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundActionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

function getCourseBySlug(slug: string) {
  return db.select().from(courses).where(eq(courses.slug, slug)).get();
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to request a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundParamsSchema);
  const course = getCourseBySlug(slug);

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const purchase = findPurchaseToRefund(db, currentUserId, course.id);

  if (!purchase) {
    throw data("You have not bought this course.", { status: 403 });
  }

  // Turn an ineligible Student away before asking them to fix their reason.
  const now = new Date();
  const check = checkRefundRequest(db, purchase.id, currentUserId, now);
  if (!check.ok) {
    throw data(check.error, { status: check.status });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  const raised = raiseRefundRequest(
    db,
    purchase.id,
    currentUserId,
    parsed.data.reason,
    now
  );

  if (!raised.ok) {
    throw data(raised.error, { status: raised.status });
  }

  // The Refund Request is raised whether or not the confirmation goes out, so
  // a mail failure is logged rather than shown to the Student as an error.
  try {
    await sendEmail(raised.email);
  } catch (error) {
    console.error("Could not send the refund request confirmation:", error);
  }

  // A Student follows an Individual Purchase's Refund Request from Settings; a
  // Team Admin follows a Team Licence's from the team page.
  return redirect(raised.kind === "team" ? "/team" : "/settings");
}
