const express = require('express')
const { Pool } = require('pg')
const cors = require('cors')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const cookieParser = require('cookie-parser')
require('dotenv').config()

const app = express()
const PORT = process.env.PORT || 5000
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key_change_this'
// At the very top of server.js
const path = require('path')

// For production - trust proxy
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1)
}

// Update CORS middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://your-frontend-domain.vercel.app', 'https://your-custom-domain.com']
    : 'http://localhost:5173',
  credentials: true
}))

app.use(express.json())
app.use(cookieParser())

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.log('Error connecting to database:', err.message)
  } else {
    console.log('Connected to Neon PostgreSQL!')
    release()
  }
})

// ============ AUTHENTICATION MIDDLEWARE ============
const verifyToken = (req, res, next) => {
  const token = req.cookies.token
  
  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' })
  }
  
  try {
    const verified = jwt.verify(token, JWT_SECRET)
    req.user = verified
    next()
  } catch (error) {
    res.status(403).json({ error: 'Invalid token' })
  }
}

const verifyRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied. Insufficient permissions.' })
    }
    next()
  }
}

// ============ AUTH APIs ============

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body
    
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' })
    }
    
    const existingUser = await pool.query('SELECT * FROM users WHERE email = $1', [email])
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' })
    }
    
    const hashedPassword = await bcrypt.hash(password, 10)
    
    const result = await pool.query(
      'INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
      [name, email, hashedPassword, role || 'user']
    )
    
    const token = jwt.sign(
      { id: result.rows[0].id, email: result.rows[0].email, role: result.rows[0].role },
      JWT_SECRET,
      { expiresIn: '7d' }
    )
    
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000
    })
    
    res.status(201).json({
      message: 'User created successfully',
      user: result.rows[0]
    })
  } catch (err) {
    console.error('Register error:', err.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }
    
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email])
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }
    
    const user = result.rows[0]
    const validPassword = await bcrypt.compare(password, user.password)
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }
    
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    )
    
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000
    })
    
    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    })
  } catch (err) {
    console.error('Login error:', err.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token')
  res.json({ message: 'Logout successful' })
})

app.get('/api/auth/me', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role FROM users WHERE id = $1',
      [req.user.id]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============ PROPERTIES APIs ============

// GET all properties (public)
app.get('/api/properties', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, 
             (SELECT json_agg(json_build_object('id', pi.id, 'image_url', pi.image_url, 'is_cover', pi.is_cover))
              FROM property_images pi 
              WHERE pi.property_id = p.id) as images
      FROM properties p 
      ORDER BY p.id DESC
    `)
    res.json(result.rows)
  } catch (err) {
    console.error('GET properties error:', err.message)
    res.status(500).json({ error: 'Failed to fetch properties' })
  }
})

// GET single property
app.get('/api/properties/:id', async (req, res) => {
  try {
    const { id } = req.params
    const result = await pool.query(`
      SELECT p.*, 
             (SELECT json_agg(json_build_object('id', pi.id, 'image_url', pi.image_url, 'is_cover', pi.is_cover))
              FROM property_images pi 
              WHERE pi.property_id = p.id) as images
      FROM properties p 
      WHERE p.id = $1
    `, [id])
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Property not found' })
    }
    res.json(result.rows[0])
  } catch (err) {
    console.error('GET property error:', err.message)
    res.status(500).json({ error: 'Failed to fetch property' })
  }
})

// POST new property (updated with purpose)
app.post('/api/properties', verifyToken, verifyRole(['admin', 'superadmin']), async (req, res) => {
  try {
    const { 
      title, price, location, description, image_url, 
      contact_number, bhk, type, purpose, rent_price, rent_period 
    } = req.body
    
    const result = await pool.query(
      `INSERT INTO properties 
       (title, price, location, description, image_url, contact_number, bhk, type, purpose, rent_price, rent_period) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) 
       RETURNING *`,
      [title, price, location, description, image_url, contact_number, bhk, type, purpose, rent_price, rent_period]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    console.log(err.message)
    res.status(500).json({ error: err.message })
  }
})

// PUT update property (updated with purpose)
app.put('/api/properties/:id', verifyToken, verifyRole(['admin', 'superadmin']), async (req, res) => {
  try {
    const { id } = req.params
    const { 
      title, price, location, description, image_url, 
      contact_number, bhk, type, purpose, rent_price, rent_period 
    } = req.body
    
    const result = await pool.query(
      `UPDATE properties 
       SET title=$1, price=$2, location=$3, description=$4, image_url=$5, 
           contact_number=$6, bhk=$7, type=$8, purpose=$9, rent_price=$10, rent_period=$11 
       WHERE id=$12 
       RETURNING *`,
      [title, price, location, description, image_url, contact_number, bhk, type, purpose, rent_price, rent_period, id]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Property not found' })
    }
    res.json(result.rows[0])
  } catch (err) {
    console.log(err.message)
    res.status(500).json({ error: err.message })
  }
})

// DELETE property
app.delete('/api/properties/:id', verifyToken, verifyRole(['admin', 'superadmin']), async (req, res) => {
  try {
    const { id } = req.params
    
    // First delete all images from property_images
    await pool.query('DELETE FROM property_images WHERE property_id = $1', [id])
    
    // Then delete the property
    const result = await pool.query('DELETE FROM properties WHERE id = $1 RETURNING *', [id])
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Property not found' })
    }
    res.json({ message: 'Property deleted successfully' })
  } catch (err) {
    console.error('Delete property error:', err.message)
    res.status(500).json({ error: 'Failed to delete property' })
  }
})

// ============ IMAGE UPLOAD ROUTES ============
const multer = require('multer')
const cloudinary = require('cloudinary').v2

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
})

const storage = multer.memoryStorage()
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg']
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Only images allowed'))
    }
  }
})

// Upload multiple images
app.post('/api/upload/property/:propertyId/images', verifyToken, verifyRole(['admin', 'superadmin']), upload.array('images', 10), async (req, res) => {
  try {
    const { propertyId } = req.params
    const files = req.files
    
    // Check if property exists
    const propertyCheck = await pool.query('SELECT id FROM properties WHERE id = $1', [propertyId])
    if (propertyCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Property not found' })
    }
    
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' })
    }
    
    const uploadedImages = []
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: `properties/${propertyId}`,
            format: 'webp',
            transformation: [{ quality: 'auto' }]
          },
          (error, result) => {
            if (error) reject(error)
            else resolve(result)
          }
        )
        uploadStream.end(file.buffer)
      })
      
      const isFirstImage = i === 0
      const dbResult = await pool.query(
        'INSERT INTO property_images (property_id, image_url, is_cover) VALUES ($1, $2, $3) RETURNING *',
        [propertyId, result.secure_url, isFirstImage]
      )
      
      uploadedImages.push(dbResult.rows[0])
      
      if (isFirstImage) {
        await pool.query('UPDATE properties SET cover_image = $1 WHERE id = $2', [result.secure_url, propertyId])
      }
    }
    
    res.status(201).json({ images: uploadedImages })
  } catch (err) {
    console.error('Upload error:', err.message)
    res.status(500).json({ error: 'Failed to upload images' })
  }
})

// Get property images
app.get('/api/upload/property/:propertyId/images', async (req, res) => {
  try {
    const { propertyId } = req.params
    const result = await pool.query(
      'SELECT * FROM property_images WHERE property_id = $1 ORDER BY is_cover DESC, created_at ASC',
      [propertyId]
    )
    res.json(result.rows)
  } catch (err) {
    console.error('Get images error:', err.message)
    res.status(500).json({ error: 'Failed to fetch images' })
  }
})

// Set cover image
app.put('/api/upload/images/:imageId/set-cover', verifyToken, verifyRole(['admin', 'superadmin']), async (req, res) => {
  try {
    const { imageId } = req.params
    
    const imageResult = await pool.query('SELECT property_id, image_url FROM property_images WHERE id = $1', [imageId])
    if (imageResult.rows.length === 0) {
      return res.status(404).json({ error: 'Image not found' })
    }
    
    const propertyId = imageResult.rows[0].property_id
    const imageUrl = imageResult.rows[0].image_url
    
    await pool.query('UPDATE property_images SET is_cover = false WHERE property_id = $1', [propertyId])
    await pool.query('UPDATE property_images SET is_cover = true WHERE id = $1', [imageId])
    await pool.query('UPDATE properties SET cover_image = $1 WHERE id = $2', [imageUrl, propertyId])
    
    res.json({ message: 'Cover image updated' })
  } catch (err) {
    console.error('Set cover error:', err.message)
    res.status(500).json({ error: 'Failed to set cover image' })
  }
})

// Delete image
app.delete('/api/upload/images/:imageId', verifyToken, verifyRole(['admin', 'superadmin']), async (req, res) => {
  try {
    const { imageId } = req.params
    
    const imageResult = await pool.query('SELECT image_url, property_id FROM property_images WHERE id = $1', [imageId])
    if (imageResult.rows.length === 0) {
      return res.status(404).json({ error: 'Image not found' })
    }
    
    const imageUrl = imageResult.rows[0].image_url
    const propertyId = imageResult.rows[0].property_id
    
    const publicId = imageUrl.split('/').slice(-2).join('/').split('.')[0]
    await cloudinary.uploader.destroy(publicId)
    await pool.query('DELETE FROM property_images WHERE id = $1', [imageId])
    
    const remainingImages = await pool.query('SELECT * FROM property_images WHERE property_id = $1 ORDER BY created_at ASC', [propertyId])
    
    if (remainingImages.rows.length > 0) {
      await pool.query('UPDATE property_images SET is_cover = true WHERE id = $1', [remainingImages.rows[0].id])
      await pool.query('UPDATE properties SET cover_image = $1 WHERE id = $2', [remainingImages.rows[0].image_url, propertyId])
    } else {
      await pool.query('UPDATE properties SET cover_image = NULL WHERE id = $1', [propertyId])
    }
    
    res.json({ message: 'Image deleted successfully' })
  } catch (err) {
    console.error('Delete image error:', err.message)
    res.status(500).json({ error: 'Failed to delete image' })
  }
})

// ============ ADMINS APIs ============

app.get('/api/admins', verifyToken, verifyRole(['superadmin']), async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, role, created_at FROM admins ORDER BY id DESC')
    res.json(result.rows)
  } catch (err) {
    console.error('Get admins error:', err.message)
    res.status(500).json({ error: 'Failed to fetch admins' })
  }
})

app.post('/api/admins', verifyToken, verifyRole(['superadmin']), async (req, res) => {
  try {
    const { name, email, role } = req.body
    const result = await pool.query(
      'INSERT INTO admins (name, email, role) VALUES ($1, $2, $3) RETURNING *',
      [name, email, role]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    console.error('Create admin error:', err.message)
    res.status(500).json({ error: 'Failed to create admin' })
  }
})

app.delete('/api/admins/:id', verifyToken, verifyRole(['superadmin']), async (req, res) => {
  try {
    const { id } = req.params
    const result = await pool.query('DELETE FROM admins WHERE id = $1 AND role != $2 RETURNING *', [id, 'superadmin'])
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Admin not found or cannot delete super admin' })
    }
    res.json({ message: 'Admin deleted successfully' })
  } catch (err) {
    console.error('Delete admin error:', err.message)
    res.status(500).json({ error: 'Failed to delete admin' })
  }
})

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})