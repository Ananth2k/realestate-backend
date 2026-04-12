const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Pool } = require('pg');
const router = express.Router();

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer setup (memory storage)
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only images allowed'));
    }
  }
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Upload multiple images for a property
router.post('/property/:propertyId/images', upload.array('images', 10), async (req, res) => {
  try {
    const { propertyId } = req.params;
    const files = req.files;
    
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    
    const uploadedImages = [];
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      
      // Convert to WebP and upload to Cloudinary
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: `properties/${propertyId}`,
            format: 'webp',
            transformation: [{ quality: 'auto' }]
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(file.buffer);
      });
      
      // Save to database
      const isFirstImage = i === 0;
      const dbResult = await pool.query(
        'INSERT INTO property_images (property_id, image_url, is_cover) VALUES ($1, $2, $3) RETURNING *',
        [propertyId, result.secure_url, isFirstImage]
      );
      
      uploadedImages.push(dbResult.rows[0]);
      
      // If first image, also update property cover_image
      if (isFirstImage) {
        await pool.query('UPDATE properties SET cover_image = $1 WHERE id = $2', [result.secure_url, propertyId]);
      }
    }
    
    res.json({ images: uploadedImages });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all images for a property
router.get('/property/:propertyId/images', async (req, res) => {
  try {
    const { propertyId } = req.params;
    const result = await pool.query(
      'SELECT * FROM property_images WHERE property_id = $1 ORDER BY is_cover DESC, created_at ASC',
      [propertyId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set cover image
router.put('/images/:imageId/set-cover', async (req, res) => {
  try {
    const { imageId } = req.params;
    
    // Get property_id from this image
    const imageResult = await pool.query('SELECT property_id FROM property_images WHERE id = $1', [imageId]);
    if (imageResult.rows.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    const propertyId = imageResult.rows[0].property_id;
    
    // Remove cover from all images of this property
    await pool.query('UPDATE property_images SET is_cover = false WHERE property_id = $1', [propertyId]);
    
    // Set new cover
    await pool.query('UPDATE property_images SET is_cover = true WHERE id = $1', [imageId]);
    
    // Get the image URL to update property cover_image
    const coverResult = await pool.query('SELECT image_url FROM property_images WHERE id = $1', [imageId]);
    await pool.query('UPDATE properties SET cover_image = $1 WHERE id = $2', [coverResult.rows[0].image_url, propertyId]);
    
    res.json({ message: 'Cover image updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete image
router.delete('/images/:imageId', async (req, res) => {
  try {
    const { imageId } = req.params;
    
    // Get public_id from Cloudinary
    const imageResult = await pool.query('SELECT image_url, property_id FROM property_images WHERE id = $1', [imageId]);
    if (imageResult.rows.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    const imageUrl = imageResult.rows[0].image_url;
    const propertyId = imageResult.rows[0].property_id;
    
    // Extract public_id from URL
    const publicId = imageUrl.split('/').slice(-2).join('/').split('.')[0];
    
    // Delete from Cloudinary
    await cloudinary.uploader.destroy(publicId);
    
    // Delete from database
    await pool.query('DELETE FROM property_images WHERE id = $1', [imageId]);
    
    // Check if deleted image was cover
    const remainingImages = await pool.query('SELECT * FROM property_images WHERE property_id = $1 ORDER BY created_at ASC', [propertyId]);
    
    if (remainingImages.rows.length > 0) {
      // Set first remaining as cover
      await pool.query('UPDATE property_images SET is_cover = true WHERE id = $1', [remainingImages.rows[0].id]);
      await pool.query('UPDATE properties SET cover_image = $1 WHERE id = $2', [remainingImages.rows[0].image_url, propertyId]);
    } else {
      // No images left
      await pool.query('UPDATE properties SET cover_image = NULL WHERE id = $1', [propertyId]);
    }
    
    res.json({ message: 'Image deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;