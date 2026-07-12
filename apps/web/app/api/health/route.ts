import { NextResponse } from "next/server";

/**
 * Framework-plumbing health endpoint for container probes (Doc 04 §6.2).
 * This is the ONLY class of route handler permitted in Next.js — business
 * API routes are forbidden (ADR-0012, ruling N9, Doc 09 §12).
 */
export function GET() {
  return NextResponse.json({
    success: true,
    data: { status: "ok", service: "web" },
  });
}
