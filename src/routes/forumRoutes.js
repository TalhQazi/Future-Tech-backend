import express from 'express';
import { db } from '../data/store.js';

const router = express.Router();

// GET /api/v1/forum
router.get('/', (req, res) => {
  const { category, tag } = req.query;
  let threads = db.forum.find();

  if (category) {
    threads = threads.filter(t => t.category.toLowerCase().includes(category.toLowerCase()));
  }
  if (tag) {
    threads = threads.filter(t => t.tags && t.tags.some(tg => tg.toLowerCase() === tag.toLowerCase()));
  }

  res.json({ success: true, count: threads.length, threads });
});

// GET /api/v1/forum/:id
router.get('/:id', (req, res) => {
  const thread = db.forum.findById(req.params.id);
  if (!thread) {
    return res.status(404).json({ success: false, message: 'Forum thread not found' });
  }
  // increment view count
  thread.views = (thread.views || 0) + 1;
  res.json({ success: true, thread });
});

// POST /api/v1/forum (Create new diagnostic discussion)
router.post('/', (req, res) => {
  const { title, category, problemSummary, confirmedSolution, tags, authorName, authorRole, authorAvatar } = req.body;

  if (!title || !problemSummary) {
    return res.status(400).json({ success: false, message: 'Thread title and problem summary are required' });
  }

  const newThread = db.forum.createThread({
    title,
    category: category || 'Diagnostics & Powertrain',
    problemSummary,
    confirmedSolution: confirmedSolution || '',
    tags: Array.isArray(tags) ? tags : [tags || 'Diagnostics'],
    authorName: authorName || 'Marcus Vance',
    authorRole: authorRole || 'Master Diagnostic Technician',
    authorAvatar: authorAvatar || 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=150&auto=format&fit=crop&q=80'
  });

  res.status(201).json({ success: true, thread: newThread });
});

// POST /api/v1/forum/:id/reply (Add technician peer answer)
router.post('/:id/reply', (req, res) => {
  const { message, authorName, authorRole, authorAvatar } = req.body;

  if (!message) {
    return res.status(400).json({ success: false, message: 'Reply message cannot be empty' });
  }

  const updated = db.forum.addReply(req.params.id, {
    message,
    authorName: authorName || 'Sarah Jenkins',
    authorRole: authorRole || 'Service Advisor',
    authorAvatar: authorAvatar || 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150&auto=format&fit=crop&q=80'
  });

  if (!updated) {
    return res.status(404).json({ success: false, message: 'Thread not found' });
  }

  res.status(201).json({ success: true, thread: updated });
});

// POST /api/v1/forum/:id/upvote
router.post('/:id/upvote', (req, res) => {
  const updated = db.forum.upvote(req.params.id);
  if (!updated) {
    return res.status(404).json({ success: false, message: 'Thread not found' });
  }
  res.json({ success: true, likes: updated.likes });
});

export default router;
