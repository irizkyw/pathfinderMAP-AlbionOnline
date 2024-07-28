const express = require('express');
const multer = require('multer');
const { createCanvas, loadImage } = require('canvas');
const { Grid, BiAStarFinder, DiagonalMovement } = require('pathfinding');
const path = require('path');

const app = express();
const PORT = 3000;

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const heuristic = {
    manhattan: (dx, dy) => dx + dy,
    euclidean: (dx, dy) => Math.sqrt(dx * dx + dy * dy),
    octile: (dx, dy) => Math.max(dx, dy) + (Math.sqrt(2) - 1) * Math.min(dx, dy),
    chebyshev: (dx, dy) => Math.max(dx, dy)
};

const isObstacle = (r, g, b, threshold = 10) => {
    const colors = [
        { r: 98, g: 86, b: 50 },   // #625632
        { r: 32, g: 44, b: 12 },   // #202c0c
        { r: 141, g: 94, b: 74 },  // #8d5e4a
        { r: 74, g: 74, b: 108 },  // #4a4a6c
        { r: 71, g: 106, b: 153 }, // #476a99
        { r: 117, g: 138, b: 126 },// #758a7e
        { r: 74, g: 114, b: 133 }, // #4a7285
    ];

    return colors.some(color => 
        Math.abs(r - color.r) <= threshold && 
        Math.abs(g - color.g) <= threshold && 
        Math.abs(b - color.b) <= threshold
    );
};

const applyBufferZone = (gridData, width, height, bufferSize = 2) => {
    const bufferedGrid = gridData.map(row => row.slice());

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (gridData[y][x] === 1) {
                for (let dy = -bufferSize; dy <= bufferSize; dy++) {
                    for (let dx = -bufferSize; dx <= bufferSize; dx++) {
                        const newY = y + dy;
                        const newX = x + dx;
                        if (newX >= 0 && newX < width && newY >= 0 && newY < height) {
                            bufferedGrid[newY][newX] = 1;
                        }
                    }
                }
            }
        }
    }

    return bufferedGrid;
};

const smoothGrid = (gridData, width, height) => {
    const smoothGrid = gridData.map(row => row.slice());

    for (let y = 2; y < height - 2; y++) {
        for (let x = 2; x < width - 2; x++) {
            let obstacleCount = 0;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    if (gridData[y + dy][x + dx] === 1) {
                        obstacleCount++;
                    }
                }
            }
            smoothGrid[y][x] = obstacleCount >= 17 ? 1 : 0;
        }
    }

    return smoothGrid;
};

const createClusters = (gridData, clusterSize) => {
    const clusters = [];
    for (let y = 0; y < gridData.length; y += clusterSize) {
        for (let x = 0; x < gridData[0].length; x += clusterSize) {
            const cluster = [];
            for (let dy = 0; dy < clusterSize; dy++) {
                const row = [];
                for (let dx = 0; dx < clusterSize; dx++) {
                    if (y + dy < gridData.length && x + dx < gridData[0].length) {
                        row.push(gridData[y + dy][x + dx]);
                    } else {
                        row.push(0);
                    }
                }
                cluster.push(row);
            }
            clusters.push({ x, y, data: cluster });
        }
    }
    return clusters;
};

app.post('/upload', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const imagePath = path.join(__dirname, req.file.path);
        console.log('Image path:', imagePath);
        
        const image = await loadImage(imagePath);

        const canvas = createCanvas(image.width, image.height);
        const ctx = canvas.getContext('2d');

        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const gridData = [];

        for (let y = 0; y < imageData.height; y++) {
            const row = [];
            for (let x = 0; x < imageData.width; x++) {
                const index = (y * imageData.width + x) * 4;
                const r = imageData.data[index];
                const g = imageData.data[index + 1];
                const b = imageData.data[index + 2];
                row.push(isObstacle(r, g, b) ? 1 : 0);
            }
            gridData.push(row);
        }

        const width = imageData.width;
        const height = imageData.height;

        const bufferedGridData = applyBufferZone(gridData, width, height);
        const smoothGridData = smoothGrid(bufferedGridData, width, height);

        const clusterSize = 128;
        const clusters = createClusters(smoothGridData, clusterSize);

        res.json({ clusters });
    } catch (error) {
        console.error('Error processing image:', error);
        res.status(500).json({ error: 'Failed to process image' });
    }
});

app.post('/find-path', async (req, res) => {
    try {
        const { clusters, startX, startY, endX, endY, heuristicType } = req.body;

        console.log('Received clusters:', clusters);

        if (!clusters || !Array.isArray(clusters) || clusters.length === 0) {
            return res.status(400).json({ error: 'Invalid clusters data' });
        }

        const heuristicFunction = heuristic[heuristicType] || heuristic.manhattan;

        const combinedGrid = [];
        const clusterSize = clusters[0].data.length;

        clusters.forEach(cluster => {
            for (let y = 0; y < cluster.data.length; y++) {
                const rowIndex = cluster.y + y;
                if (!combinedGrid[rowIndex]) {
                    combinedGrid[rowIndex] = [];
                }
                combinedGrid[rowIndex].splice(cluster.x, cluster.data[y].length, ...cluster.data[y]);
            }
        });

        const grid = new Grid(combinedGrid);
        const finder = new BiAStarFinder({
            heuristic: heuristicFunction,
            diagonalMovement: DiagonalMovement.Always
        });

        const path = finder.findPath(startX, startY, endX, endY, grid);

        res.json({ path });
    } catch (error) {
        console.error('Error finding path:', error);
        res.status(500).json({ error: 'Failed to find path' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
