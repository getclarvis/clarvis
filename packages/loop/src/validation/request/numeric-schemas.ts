import { z } from "zod";

export const positiveIntField = (label: string) =>
  z
    .number({ error: `${label} must be a positive integer` })
    .int(`${label} must be a positive integer`)
    .positive(`${label} must be a positive integer`);

export const nonnegativeIntField = (label: string) =>
  z
    .number({ error: `${label} must be a non-negative integer` })
    .int(`${label} must be a non-negative integer`)
    .nonnegative(`${label} must be a non-negative integer`);
