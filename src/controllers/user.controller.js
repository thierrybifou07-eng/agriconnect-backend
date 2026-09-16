const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');

// GET /api/users/me
const getMe = asyncHandler(async (req, res) => {
  const { password, ...userSafe } = req.user;
  res.json(userSafe);
});

// PATCH /api/users/me
const updateMe = asyncHandler(async (req, res) => {
  const { fullName, email, location, avatarUrl } = req.body;

  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: {
      ...(fullName && { fullName }),
      ...(email !== undefined && { email }),
      ...(location !== undefined && { location }),
      ...(avatarUrl !== undefined && { avatarUrl }),
    },
  });

  const { password, ...userSafe } = updated;
  res.json(userSafe);
});

// PATCH /api/users/me/availability  (livreur uniquement)
// Met à jour la position GPS courante et le statut de disponibilité du livreur
const updateAvailability = asyncHandler(async (req, res) => {
  const { isAvailable, latitude, longitude } = req.body;

  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: {
      ...(isAvailable !== undefined && { isAvailable }),
      ...(latitude !== undefined && { latitude }),
      ...(longitude !== undefined && { longitude }),
    },
  });

  const { password, ...userSafe } = updated;
  res.json(userSafe);
});

module.exports = { getMe, updateMe, updateAvailability };
