import { neon } from "@neondatabase/serverless";
export const sql = neon(process.env.DATABASE_URL as string);
export const region = process.env.AWS_REGION ?? "eu-central-1";
