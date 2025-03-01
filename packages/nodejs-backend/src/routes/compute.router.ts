import { forwardRequest, upload } from "@/common";
import ComputeController from "@/controllers/compute";

import { Router } from "express";

const ComputeRouter = Router({ mergeParams: true });

ComputeRouter.post(
  "/upload-to-pinata",
  // @ts-ignore
  upload.single("file"),
  forwardRequest(ComputeController.uploadToPinata)
);

export default ComputeRouter;
