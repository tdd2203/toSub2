#!/usr/bin/env node
// Mock login flow that stays on the email-code step: "r" asks for a new code,
// any 6-digit code finishes the flow.

import readline from "node:readline";

const emailIndex = process.argv.indexOf("--email");
const email = emailIndex >= 0 ? process.argv[emailIndex + 1] : "unknown@example.invalid";
console.log(`[1/5] Mock resend login started for ${email}`);
console.log(`[email-otp-requested-at] ${new Date().toISOString()}`);
console.log("Email OTP (r=resend, q=quit):");

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const value = line.trim();
  if (value === "r") {
    console.log("[mock] email OTP resent");
    console.log(`[email-otp-requested-at] ${new Date().toISOString()}`);
    console.log("Email OTP (r=resend, q=quit):");
  } else if (/^\d{6}$/.test(value)) {
    console.log(`[mock] email OTP accepted ${value}`);
  }
}
