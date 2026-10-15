import { Type } from "typebox";

// TODO(schemas.md section 4): ids are ULIDs. The exact format is not fixed there; the length of 26
// comes from ORCHESTRATION.md validation. Branded types (`Brand<string, "TaskId">`) are not
// expressed in TypeBox and are left to the consumers.
const UlidSchema = Type.String({ minLength: 26, maxLength: 26 });

export const TaskIdSchema = UlidSchema;
export const ProjectIdSchema = UlidSchema;
export const RunIdSchema = UlidSchema;
export const SessionIdSchema = UlidSchema;
