const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const musicMetadata = require("music-metadata");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(
  express.urlencoded({ extended: true, parameterLimit: 100000, limit: "50mb" })
);

app.use(
  cors({
    origin: "*",
    methods: ["GET", "PUT", "POST", "DELETE"],
    allowedHeaders: ["Content-Type"],
  })
);

const PORT = process.env.PORT || 4000;
const BASE_URL = process.env.BASE_URL;
const MONGO_URI = process.env.MONGO_URI;

// AWS S3 Configuration (SDK v3)
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

const getFormattedDate = () => {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();

  const randomNum = String(Math.floor(100000 + Math.random() * 900000)); // Generates 6-digit random number

  return `${year}${month}${day}${randomNum}`;
};

// Multer Storage for AWS S3
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["audio/mpeg", "audio/wav", "audio/flac", "audio/ogg"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type."), false);
    }
  },
});

// Connect to MongoDB
async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log("Connected to MongoDB successfully!");
  } catch (error) {
    console.error("MongoDB Connection Error:", error.message);
    process.exit(1);
  }
}
connectDB();

// MongoDB Schema
const FileSchema = new mongoose.Schema({
  filename: String,
  viewUrl: String,
  downloadUrl: String,
  coverImageUrl: String,
  key: String,
  uploadedAt: { type: Date, default: Date.now },
});
const File = mongoose.model("File", FileSchema);

// Upload File Route
app.post("/upload", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: "No files uploaded" });

    const uploadedFiles = await Promise.all(
      req.files.map(async (file) => {
        const fileKey = file.originalname.replace(/\s+/g, "_");

        let coverImageKey = null;
        if (file.mimetype.startsWith("audio/")) {
          const metadata = await musicMetadata.parseBuffer(file.buffer);

          const fileBaseName = file.originalname
            .replace(/\s+/g, "_")
            .replace(/\.[a-zA-Z0-9]+$/, "");

          const year = metadata.common.year || null;
          const language = metadata.common.language || "English";

          if (metadata.common.picture && metadata.common.picture.length > 0) {
            const coverImageBuffer = metadata.common.picture[0].data;

            const imageMimeType =
              metadata.common.picture[0].format ||
              "image/jpg" ||
              "image/jpeg" ||
              "image/png";
              
            const imageExt = imageMimeType.split("/")[1];

            coverImageKey = `${fileBaseName}-${language}-${
              year ? year : null
            }-${getFormattedDate()}.${imageExt}`;

            // Upload cover image to S3
            await s3.send(
              new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: coverImageKey,
                Body: coverImageBuffer,
                ContentType: imageMimeType,
                ContentDisposition: `inline; filename="${coverImageKey}"`,
              })
            );
          }
        }

        // 🔹 Upload to S3 with public read access
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: fileKey,
            Body: file.buffer,
            ContentType: file.mimetype,
            ContentDisposition: `inline; filename="${fileKey}"`, // For view
          })
        );

        // 🔹 Save Metadata in MongoDB
        const viewUrl = `${BASE_URL}/view/${encodeURIComponent(fileKey)}`;
        const downloadUrl = `${BASE_URL}/download/${encodeURIComponent(
          fileKey
        )}`;
        const coverImageUrl = coverImageKey
          ? `${BASE_URL}/viewCoverImage/${encodeURIComponent(coverImageKey)}`
          : null;

        const newFile = await File.create({
          filename: fileKey,
          viewUrl,
          downloadUrl,
          coverImageUrl,
          key: fileKey,
        });

        return newFile;
      })
    );

    res.json({ message: "Files uploaded successfully!", files: uploadedFiles });
  } catch (error) {
    console.error("Upload Error:", error);
    res.status(500).json({ error: "File upload failed" });
  }
});

// Get all files
app.get("/files", async (req, res) => {
  try {
    const files = await File.find().sort({ uploadedAt: -1 });
    res.json(files);
  } catch (error) {
    console.error("Fetch Error:", error);
    res.status(500).json({ error: "Failed to retrieve files" });
  }
});

// 👀 **View File (Direct URL)**
app.get("/view/:key", async (req, res) => {
  try {
    const fileKey = decodeURIComponent(req.params.key);
    const viewUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileKey}`;
    res.setHeader("Content-Disposition", "inline"); // Instruct browser to display inline
    res.redirect(viewUrl); // Directly redirects to the public URL for viewing
  } catch (error) {
    console.error("View File Error:", error);
    res.status(500).json({ error: "Failed to view file" });
  }
});

// **View Cover Image** - API for viewing the cover image
app.get("/viewCoverImage/:key", async (req, res) => {
  try {
    const coverImageKey = decodeURIComponent(req.params.key);
    const coverImageUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${coverImageKey}`;
    res.setHeader("Content-Disposition", "inline"); // Instruct browser to display inline
    res.redirect(coverImageUrl); // Directly redirects to the public URL for the cover image
  } catch (error) {
    console.error("View Cover Image Error:", error);
    res.status(500).json({ error: "Failed to view cover image" });
  }
});

// 📥 **Download File (Forces Download)**
app.get("/download/:key", async (req, res) => {
  try {
    const fileKey = decodeURIComponent(req.params.key); // Get file key from URL

    // 🔹 Generate a pre-signed URL (valid for 60 seconds)
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey,
      ResponseContentDisposition: `attachment; filename="${fileKey}"`, // Force download with original filename
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 });

    // Redirect user to the signed URL (forces download)
    res.redirect(signedUrl);
  } catch (error) {
    console.error("Download Error:", error);
    res.status(500).json({ error: "Failed to generate download link" });
  }
});

// Delete File
app.delete("/files/:id", async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    if (!file) return res.status(404).json({ error: "File not found" });

    // 🔹 Delete from S3
    await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: file.key,
      })
    );

    if (file.coverImageUrl) {
      const coverImageKey = file.coverImageUrl.split("/").pop();
      await s3.send(
        new DeleteObjectCommand({
          Bucket: BUCKET_NAME,
          Key: coverImageKey,
        })
      );
    }

    // 🔹 Remove from MongoDB
    await file.deleteOne();

    res.json({ message: "File deleted successfully" });
  } catch (error) {
    console.error("Delete Error:", error);
    res.status(500).json({ error: "Failed to delete file" });
  }
});

app.use((req, res) => res.send(`Server running on - ${BASE_URL}`));
app.listen(PORT, () => console.log(`Server running on port - ${PORT}`));

// module.exports = app;
