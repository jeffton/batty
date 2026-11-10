import { Type } from "typebox";

export const CloudBrowserCredentialsSchema = Type.Object(
  {
    target: Type.Object(
      {
        loginId: Type.String({ maxLength: 100 }),
        pageId: Type.String({ maxLength: 200 }),
        revision: Type.String({ maxLength: 100 }),
        url: Type.String({ maxLength: 16384 }),
        origin: Type.String({ maxLength: 2048 }),
        token: Type.String({ maxLength: 100 }),
      },
      { additionalProperties: false },
    ),
    username: Type.String({ maxLength: 4096 }),
    password: Type.String({ maxLength: 16384 }),
  },
  { additionalProperties: false },
);
