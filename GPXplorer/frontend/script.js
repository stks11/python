const API_BASE = 'http://127.0.0.1:8000';

let map = L.map('map', {
    doubleClickZoom: false
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    crossOrigin: true
}).addTo(map);

map.locate({ setView: true, maxZoom: 16 });

map.on('locationfound', function (e) {
    let radius = e.accuracy / 5;
    L.circle(e.latlng, radius).addTo(map);
});

map.on('locationerror', function () {
    map.setView([52.237049, 21.017532], 7);
});

L.Control.geocoder({
    drawMarker: true,
    icon: 'fa fa-map-marker',
    iconLoading: 'fa fa-spinner fa-spin',
    markerClass: L.circleMarker,
}).addTo(map);

L.control.locate().addTo(map);

let selectedSegments = [];
let trackLayer = null;
let coordinates = [];
let elevationChart = null;
let segments = [];
let layers = [];
let layersCoordinates = [];

const fileButton = document.getElementById('fileButton');
const fileInput = document.getElementById('fileInput');
const dialog = document.getElementById('choose');
const dialogDownload = document.getElementById('dialogDownload');
const ileInput = document.getElementById('ile');
const ile2Input = document.getElementById('ile2');

async function postJson(endpoint, payload) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        let message = `Blad backendu: ${response.status}`;
        try {
            const errorData = await response.json();
            if (errorData.detail) {
                message = errorData.detail;
            }
        } catch (error) {
        }
        throw new Error(message);
    }

    return response;
}

function getSelectedCoordinates() {
    return selectedSegments
        .map(({ layer }) => layer?.feature?.geometry?.coordinates)
        .filter(segmentCoordinates => Array.isArray(segmentCoordinates) && segmentCoordinates.length > 1);
}

function addTrackLayer(trackCoordinates, fileLabel, style = { weight: 3 }) {
    const trackJSON = {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: trackCoordinates
        }
    };

    const layer = L.geoJSON(trackJSON, { style: style }).addTo(map);
    layer.fileName = fileLabel;
    layers.push(layer);
    layersCoordinates.push(trackCoordinates);
    layerSelection(layer);
    return layer;
}

fileButton.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', async function (event) {
    const file = event.target.files[0];
    if (!file) {
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch(`${API_BASE}/upload-gpx`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Blad backendu: ${response.status}`);
        }

        const data = await response.json();
        coordinates = data.coordinates;

        if (!coordinates || coordinates.length < 2) {
            alert('Nie udalo sie wczytac poprawnej trasy z pliku GPX.');
            return;
        }

        trackLayer = addTrackLayer(coordinates, file.name);
        manageLayersControl();
        map.fitBounds(trackLayer.getBounds());
        console.log(`Wczytano ${data.points_count} punktow`);
    } catch (error) {
        console.error('Blad wczytywania GPX:', error);
        alert('Nie udalo sie wczytac pliku przez backend FastAPI.');
    }
});

function layerSelection(layer) {
    if (layer.eachLayer) {
        layer.eachLayer(function (segmentLayer) {
            setupLayerClick(segmentLayer);
        });
    } else {
        setupLayerClick(layer);
    }
}

function setupLayerClick(layer) {
    layer.on('click', function () {
        const modifiedId = layer._leaflet_id + 1;
        const existingSegment = selectedSegments.find(item => item.layer === layer);
        if (existingSegment) {
            selectedSegments = selectedSegments.filter(item => item.layer !== layer);
            layer.setStyle({ weight: 3 });
        } else {
            selectedSegments.push({ layer: layer, modifiedId: modifiedId });
            layer.setStyle({ weight: 5 });
        }
    });
}

async function mergeGPX() {
    if (selectedSegments.length === 0) {
        alert('Zaznacz segmenty do scalenia');
        return;
    }

    const segmentsToMerge = getSelectedCoordinates();
    if (segmentsToMerge.length === 0) {
        alert('Brak segmentow do scalenia');
        return;
    }

    let mergedCoordinates;
    try {
        const response = await postJson('/merge-gpx', { segments: segmentsToMerge });
        const data = await response.json();
        mergedCoordinates = data.coordinates;
    } catch (error) {
        alert(error.message);
        return;
    }

    const mergedTrackLayer = addTrackLayer(
        mergedCoordinates,
        `Polaczone - ${Date.now()}`,
        { weight: 3 }
    );

    const layersList = document.getElementById('layersList');
    selectedSegments.forEach(({ modifiedId }) => {
        const layerIndex = layers.findIndex(layer => layer._leaflet_id === modifiedId);
        if (layerIndex !== -1) {
            map.removeLayer(layers[layerIndex]);
            layers.splice(layerIndex, 1);
            layersCoordinates.splice(layerIndex, 1);
        }

        const listItem = layersList.querySelector(`[data-layer-id="${modifiedId}"]`);
        if (listItem) {
            layersList.removeChild(listItem);
        }
    });

    selectedSegments = [];
    manageLayersControl();
    map.fitBounds(mergedTrackLayer.getBounds());
}

async function fetchRouteFromOSRM(start, end) {
    const url = `https://router.project-osrm.org/route/v1/driving/${start[0]},${start[1]};${end[0]},${end[1]}?overview=full&geometries=geojson`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        return data.routes[0].geometry;
    } catch (error) {
        console.error('Blad:', error);
        throw error;
    }
}

function fillGap() {
    if (selectedSegments.length > 1) {
        const firstPoint = selectedSegments[0].layer.feature.geometry.coordinates;
        const lastPoint = selectedSegments[1].layer.feature.geometry.coordinates;
        const latlngfirst = firstPoint.at(-1);
        const start = [latlngfirst[0], latlngfirst[1]];
        const latlnglast = lastPoint.at(0);
        const end = [latlnglast[0], latlnglast[1]];
        fetchRouteFromOSRM(start, end)
            .then((routeGeometry) => {
                const lineString = {
                    type: 'Feature',
                    geometry: routeGeometry
                };
                const color = 'black';
                const lineLayer = L.geoJSON(lineString, { style: { color: color } }).addTo(map);
                layers.push(lineLayer);
                layersCoordinates.push(routeGeometry.coordinates);
                layerSelection(lineLayer);
                selectedSegments = [];
                lineLayer.fileName = `Fill - ${color}`;
                manageLayersControl();
            })
            .catch(() => {
            });
    } else if (selectedSegments.length === 0) {
        alert('Zaznacz dwie widoczne warstwy');
    } else {
        alert('Zaznacz tylko dwie widoczne warstwy');
    }
}

document.getElementById('ile').style.display = 'none';
document.getElementById('ile2').style.display = 'none';
document.querySelector('label[for="ile"]').style.display = 'none';
document.querySelector('label[for="ile2"]').style.display = 'none';

function splitGPXHandler() {
    if (layers.length === 0) {
        alert('Brak warstw na mapie, dodaj warstwy aby wykonac operacje');
    } else if (selectedSegments.length > 1) {
        alert('Zaznaczono zbyt wiele warstw. Zaznacz jedna widoczna warstwe');
    } else if (selectedSegments.length === 1 || layers.length === 1) {
        dialog.showModal();
        const wyborForm = dialog.querySelector('form');
        wyborForm.querySelectorAll('input[name="wybor"]').forEach(input => {
            input.addEventListener('change', function () {
                document.getElementById('ile').style.display = 'none';
                document.querySelector('label[for="ile"]').style.display = 'none';
                document.getElementById('ile2').style.display = 'none';
                document.querySelector('label[for="ile2"]').style.display = 'none';
                if (this.value === 'opcja1') {
                    document.getElementById('ile').style.display = 'inline';
                    document.querySelector('label[for="ile"]').style.display = 'inline';
                } else if (this.value === 'opcja2') {
                    document.getElementById('ile2').style.display = 'inline';
                    document.querySelector('label[for="ile2"]').style.display = 'inline';
                }
            });
        });
    }
}

async function splitGPX() {
    const layersList = document.getElementById('layersList');
    let layerToSplit;
    let modifiedId;

    if (layers.length === 1) {
        layerToSplit = layers[0];
        modifiedId = layerToSplit._leaflet_id;
    } else if (selectedSegments.length > 0) {
        ({ layer: layerToSplit, modifiedId } = selectedSegments[0]);
    } else {
        alert('Wybierz warstwe do podzialu');
        return;
    }

    const index = layers.findIndex(layer =>
        layer._leaflet_id === layerToSplit._leaflet_id || layer._leaflet_id === modifiedId
    );

    if (index === -1) {
        alert('Nie mozna znalezc warstwy');
        return;
    }

    const coordinatesToSplit = layersCoordinates[index];
    if (!coordinatesToSplit || coordinatesToSplit.length === 0) {
        return;
    }

    const selectedOption = document.querySelector('input[name="wybor"]:checked')?.value;
    if (!selectedOption) {
        alert('Wybierz opcje podzialu');
        return;
    }

    let response;
    try {
        if (selectedOption === 'opcja1') {
            const parts = parseInt(ileInput.value, 10);
            if (isNaN(parts) || parts <= 0) {
                alert('Podaj poprawna liczbe czesci');
                return;
            }
            response = await postJson('/split-gpx', {
                coordinates: coordinatesToSplit,
                mode: 'parts',
                parts: parts
            });
        } else if (selectedOption === 'opcja2') {
            const segmentLengthKm = parseFloat(ile2Input.value);
            if (isNaN(segmentLengthKm) || segmentLengthKm <= 0) {
                alert('Podaj poprawna dlugosc');
                return;
            }
            response = await postJson('/split-gpx', {
                coordinates: coordinatesToSplit,
                mode: 'distance',
                segment_length_km: segmentLengthKm
            });
        }
    } catch (error) {
        alert(error.message);
        return;
    }

    const data = await response.json();
    const segmentsToAdd = data.segments;

    if (!segmentsToAdd || segmentsToAdd.length === 0) {
        alert('Warstwa nie zostala podzielona');
        return;
    }

    map.removeLayer(layerToSplit);
    layers.splice(index, 1);
    layersCoordinates.splice(index, 1);

    const listItem = layersList.querySelector(`[data-layer-id="${modifiedId}"]`);
    if (listItem) {
        layersList.removeChild(listItem);
    }

    segments = [];
    segmentsToAdd.forEach((segmentCoordinates, index) => {
        const colors = ['red', 'green', 'orange', 'purple', 'yellow'];
        const color = colors[index % colors.length];
        const trackSegmentLayer = addTrackLayer(
            segmentCoordinates,
            `Segment ${index + 1} - ${color}`,
            { color: color, weight: 3 }
        );
        segments.push(trackSegmentLayer);
    });

    selectedSegments = [];
    manageLayersControl();
    dialog.close();
}

document.getElementById('divide').addEventListener('click', () => {
    splitGPX();
});

function clearMap() {
    const layersList = document.getElementById('layersList');
    if (selectedSegments.length > 0) {
        selectedSegments.forEach(({ modifiedId }) => {
            const layerIndex = layers.findIndex(layer => layer._leaflet_id === modifiedId);
            if (layerIndex !== -1) {
                map.removeLayer(layers[layerIndex]);
                layers.splice(layerIndex, 1);
                layersCoordinates.splice(layerIndex, 1);
            }
            const listItem = layersList.querySelector(`[data-layer-id="${modifiedId}"]`);
            if (listItem) {
                layersList.removeChild(listItem);
            }
        });
        selectedSegments = [];
        return;
    }

    if (layers.length > 0) {
        layers.forEach(layer => {
            if (layer) {
                map.removeLayer(layer);
            }
        });
        layers = [];
    }

    trackLayer = null;
    layersCoordinates = [];
    coordinates = [];
    selectedSegments = [];
    segments = [];

    if (layersList) {
        layersList.innerHTML = '';
    }

    const tableBody = document.getElementById('statsTable')?.querySelector('tbody');
    if (tableBody) {
        tableBody.innerHTML = '';
    }

    const statsTable = document.getElementById('statsTable');
    if (statsTable) {
        statsTable.style.display = 'none';
    }

    const chartElement = document.getElementById('elevationChart');
    if (chartElement) {
        chartElement.style.display = 'none';
    }

    if (elevationChart !== null) {
        elevationChart.destroy();
        elevationChart = null;
    }

    const fileInputElement = document.getElementById('fileInput');
    if (fileInputElement) {
        fileInputElement.value = '';
    }
}

document.getElementById('save').addEventListener('click', async (e) => {
    e.preventDefault();
    if ((!segments || segments.length === 0) && !trackLayer) {
        alert('Brak danych do zapisania.');
        return;
    }

    let dataToSave = [];
    if (selectedSegments.length > 0) {
        selectedSegments.forEach(segment => {
            const selectedCoordinates = segment.layer.feature.geometry.coordinates;
            dataToSave = dataToSave.concat(selectedCoordinates);
        });
    } else if (coordinates.length > 0) {
        dataToSave = coordinates;
    } else {
        alert('Brak wybranych segmentow do zapisania.');
        return;
    }

    const fileNameInput = document.getElementById('stext');
    const fileName = fileNameInput && fileNameInput.value.trim() ? fileNameInput.value.trim() : 'Trasa';

    try {
        const response = await postJson('/export-gpx', {
            coordinates: dataToSave,
            file_name: fileName
        });
        const blob = await response.blob();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${fileName}.gpx`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        dialogDownload.close();
    } catch (error) {
        alert(error.message);
    }
});

function downloadGPXHandler() {
    if (layers.length > 0) {
        dialogDownload.showModal();
    } else {
        alert('Brak danych do zapisania!');
    }
    const name = document.getElementById('stext');
    name.value = '';
    const check = document.getElementById('select');
    check.checked = false;
}

function createElevationChart(distances, elevations) {
    const ctx = document.getElementById('elevationChart').getContext('2d');
    const formattedDistances = distances.map(value => parseFloat(value.toFixed(2)));
    const formattedElevations = elevations.map(value => parseFloat(value.toFixed(2)));
    if (elevationChart !== null) {
        elevationChart.destroy();
    }
    elevationChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: formattedDistances,
            datasets: [{
                label: 'Wysokosc n.p.m. (m)',
                data: formattedElevations,
                borderColor: 'rgba(75, 192, 192, 1)',
                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                fill: true,
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            scales: {
                x: {
                    display: true,
                    title: {
                        display: true,
                        text: 'Odleglosc (km)'
                    }
                },
                y: {
                    display: true,
                    title: {
                        display: true,
                        text: 'Przewyzszenie (m)'
                    }
                }
            }
        }
    });
}

function createButton(text, title, onClick, container) {
    const button = L.DomUtil.create('a', '', container);
    button.href = '#';
    button.textContent = text;
    button.style.background = 'white';
    button.title = title;

    L.DomEvent.on(button, 'click', function (e) {
        L.DomEvent.stopPropagation(e);
        L.DomEvent.preventDefault(e);
        onClick();
    });

    return button;
}

let CustomControl = L.Control.extend({
    options: {
        position: 'topright'
    },
    onAdd: function () {
        let container = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-custom');

        createButton('D', 'Dzieli zaznaczona warstwe na segmenty', splitGPXHandler, container);
        createButton('M', 'Laczy zaznaczone segmenty w jedna warstwe', mergeGPX, container);
        createButton('S', 'Wyswietla statystyki zaznaczonej warstwy', stats, container);
        createButton('C', 'Czysci mape lub usuwa wskazane warstwy', clearMap, container);
        createButton('v', 'Zapisuje wskazana warstwe do pliku', downloadGPXHandler, container);
        createButton('F', 'Wypelnia luke pomiedzy dwoma warstwami', fillGap, container);

        return container;
    }
});

map.addControl(new CustomControl());

const LayersControl = L.Control.extend({
    options: {
        position: 'topleft'
    },
    onAdd: function () {
        const container = L.DomUtil.create('div', 'leaflet-control-layers');
        container.style.backgroundColor = 'white';
        container.style.padding = '10px';
        container.style.maxHeight = '200px';
        container.style.overflowY = 'auto';
        container.style.fontSize = '14px';

        const header = L.DomUtil.create('strong', '', container);
        header.textContent = 'Warstwy:';

        const layersList = L.DomUtil.create('ul', '', container);
        layersList.id = 'layersList';
        layersList.style.listStyle = 'none';
        layersList.style.padding = '0';

        L.DomEvent.disableClickPropagation(container);

        return container;
    }
});

map.addControl(new LayersControl());

function manageLayersControl() {
    const layersList = document.getElementById('layersList');
    layersList.innerHTML = '';

    layers.forEach((layer, index) => {
        const listItem = document.createElement('li');
        listItem.style.display = 'flex';
        listItem.style.marginBottom = '5px';
        listItem.dataset.layerId = layer._leaflet_id;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.style.cursor = 'pointer';
        checkbox.checked = map.hasLayer(layer);

        const label = document.createElement('span');
        label.textContent = layer.fileName || `Warstwa ${index + 1}`;

        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                map.addLayer(layer);
            } else {
                map.removeLayer(layer);
            }
        });

        listItem.appendChild(checkbox);
        listItem.appendChild(label);
        layersList.appendChild(listItem);
    });
}

async function stats() {
    const statsTable = document.getElementById('statsTable');
    const tableBody = statsTable.querySelector('tbody');

    if (statsTable.style.display === 'table') {
        statsTable.style.display = 'none';
        document.getElementById('elevationChart').style.display = 'none';
        return;
    }

    if (selectedSegments.length === 0) {
        alert('Nie zaznaczono warstwy lub brak punktow.');
        return;
    }

    const selectedCoordinates = getSelectedCoordinates();
    if (selectedCoordinates.length === 0) {
        alert('Nie zaznaczono warstwy lub brak punktow.');
        return;
    }

    let statsData;
    try {
        const response = await postJson('/stats-gpx', { segments: selectedCoordinates });
        statsData = await response.json();
    } catch (error) {
        alert(error.message);
        return;
    }

    tableBody.innerHTML = '';
    const row = document.createElement('tr');
    const cellCount = document.createElement('td');
    const cellLength = document.createElement('td');
    const cellElevation = document.createElement('td');

    cellCount.textContent = statsData.point_count;
    cellLength.textContent = Number(statsData.total_length_km).toFixed(2);
    cellElevation.textContent = Number(statsData.elevation_gain_m).toFixed(0);

    row.appendChild(cellCount);
    row.appendChild(cellLength);
    row.appendChild(cellElevation);
    tableBody.appendChild(row);
    statsTable.style.display = 'table';

    if (statsData.distances_km.length > 0 && statsData.elevations_m.length > 0) {
        createElevationChart(statsData.distances_km, statsData.elevations_m);
        document.getElementById('elevationChart').style.display = 'block';
    }
}
